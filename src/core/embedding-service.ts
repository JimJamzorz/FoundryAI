/* ==========================================================================
   Embedding Service - Manages RAG pipeline: chunking, indexing, retrieval
   ========================================================================== */

import { openRouterService } from './openrouter-service'
import { VectorStore, type VectorEntry, type IndexMeta, type SearchResult } from './vector-store'
import { collectionReader, type ExtractedDocument } from './collection-reader'
import { getSetting } from '../settings'

/**
 * Task prefixes some embedding families REQUIRE to perform as trained —
 * serving endpoints (LM Studio, plain OpenAI-compatible APIs) do not add
 * them, so we must. Embedding without them quietly degrades retrieval.
 *   - nomic-embed-text: "search_document: " for passages, "search_query: " for queries
 *   - mxbai / bge (en): instruction on the QUERY side only
 * Prefixes are applied at embed time only — stored chunk text stays clean.
 * NOTE: adding/changing prefixes changes the vectors → full Reindex required.
 */
function embeddingTaskPrefixes(): { doc: string; query: string } {
	const model = (getSetting('embeddingModel') || '').toLowerCase()
	if (model.includes('nomic')) {
		return { doc: 'search_document: ', query: 'search_query: ' }
	}
	if (model.includes('mxbai') || model.includes('bge-')) {
		return { doc: '', query: 'Represent this sentence for searching relevant passages: ' }
	}
	return { doc: '', query: '' }
}

export interface IndexProgress {
	phase: 'extracting' | 'chunking' | 'embedding' | 'storing' | 'complete' | 'error'
	current: number
	total: number
	documentName?: string
	message?: string
}

export type ProgressCallback = (progress: IndexProgress) => void

// Chunk sizing is in CHARACTERS (≈4 chars per token). These were previously
// 500/50 with a comment claiming "~500 tokens" — actually ~125 tokens, far too
// small to carry coherent lore context (a chunk was a sentence and a half),
// and 4x the embedding calls for a large book. ~400 real tokens per chunk is
// the sweet spot for setting/adventure prose. NOTE: changing these requires a
// full Reindex for existing worlds.
const CHUNK_SIZE = 1600 // chars ≈ 400 tokens per chunk
const CHUNK_OVERLAP = 200 // chars carried into the next chunk for continuity
const EMBEDDING_BATCH_SIZE = 20 // chunks per embeddings API call

/** How many dense candidates to over-fetch before the keyword rerank. */
const RERANK_CANDIDATE_MULTIPLIER = 5
const RERANK_MIN_CANDIDATES = 25

export class EmbeddingService {
	private vectorStore: VectorStore | null = null

	async initialize(worldId: string): Promise<void> {
		this.vectorStore = new VectorStore(worldId)
		await this.vectorStore.open()
	}

	get isInitialized(): boolean {
		return this.vectorStore !== null
	}

	// ---- Full Reindex ----

	async reindexAll(journalFolderIds: string[], actorFolderIds: string[], onProgress?: ProgressCallback): Promise<void> {
		if (!this.vectorStore) throw new Error('EmbeddingService not initialized')
		if (!openRouterService.isConfigured) throw new Error('OpenRouter not configured')

		try {
			// Phase 1: Extract documents
			onProgress?.({ phase: 'extracting', current: 0, total: 0, message: 'Extracting documents...' })

			const journals = collectionReader.getJournalsByFolders(journalFolderIds)
			const actors = collectionReader.getActorsByFolders(actorFolderIds)
			const allDocs = [...journals, ...actors]

			if (allDocs.length === 0) {
				onProgress?.({ phase: 'complete', current: 0, total: 0, message: 'No documents to index.' })
				return
			}

			// Phase 2: Clear existing and chunk
			onProgress?.({ phase: 'chunking', current: 0, total: allDocs.length, message: 'Chunking documents...' })

			await this.vectorStore.clear()

			const allChunks: Array<{ doc: ExtractedDocument; chunkIndex: number; text: string }> = []

			for (let i = 0; i < allDocs.length; i++) {
				const doc = allDocs[i]
				const chunks = this.chunkText(doc.content)

				for (let j = 0; j < chunks.length; j++) {
					allChunks.push({ doc, chunkIndex: j, text: chunks[j] })
				}

				onProgress?.({
					phase: 'chunking',
					current: i + 1,
					total: allDocs.length,
					documentName: doc.name,
				})
			}

			// Phase 3: Generate embeddings in batches
			onProgress?.({
				phase: 'embedding',
				current: 0,
				total: allChunks.length,
				message: `Generating embeddings for ${allChunks.length} chunks...`,
			})

			const prefixes = embeddingTaskPrefixes()
			for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
				const batch = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE)
				const texts = batch.map((c) => prefixes.doc + c.text)

				const embeddingResponse = await openRouterService.generateEmbeddings(texts)

				// Phase 4: Store vectors
				const vectorEntries: VectorEntry[] = batch.map((chunk, idx) => ({
					id: `${chunk.doc.type}:${chunk.doc.id}:${chunk.chunkIndex}`,
					documentId: chunk.doc.id,
					documentType: chunk.doc.type,
					documentName: chunk.doc.name,
					folderName: chunk.doc.folderName,
					chunkIndex: chunk.chunkIndex,
					text: chunk.text,
					vector: embeddingResponse.data[idx].embedding,
					metadata: chunk.doc.metadata,
				}))

				await this.vectorStore.upsertVectors(vectorEntries)

				onProgress?.({
					phase: 'embedding',
					current: Math.min(i + EMBEDDING_BATCH_SIZE, allChunks.length),
					total: allChunks.length,
					message: `Embedded ${Math.min(i + EMBEDDING_BATCH_SIZE, allChunks.length)}/${allChunks.length} chunks`,
				})
			}

			// Update index metadata for each document
			for (const doc of allDocs) {
				const chunkCount = allChunks.filter((c) => c.doc.id === doc.id).length
				await this.vectorStore.setIndexMeta({
					documentId: doc.id,
					documentType: doc.type,
					documentName: doc.name,
					lastModified: doc.lastModified,
					chunkCount,
				})
			}

			onProgress?.({
				phase: 'complete',
				current: allChunks.length,
				total: allChunks.length,
				message: `Indexed ${allDocs.length} documents (${allChunks.length} chunks)`,
			})
		} catch (error: any) {
			onProgress?.({
				phase: 'error',
				current: 0,
				total: 0,
				message: `Indexing failed: ${error.message}`,
			})
			throw error
		}
	}

	// ---- Semantic Search ----

	async search(
		query: string,
		topK: number = 5,
		filter?: {
			documentType?: 'journal' | 'actor'
		},
	): Promise<SearchResult[]> {
		if (!this.vectorStore) throw new Error('EmbeddingService not initialized')
		if (!openRouterService.isConfigured) throw new Error('OpenRouter not configured')

		// Generate embedding for the query (with the model family's query prefix)
		const embeddingResponse = await openRouterService.generateEmbeddings(embeddingTaskPrefixes().query + query)
		const queryVector = embeddingResponse.data[0].embedding

		// Hybrid retrieval: over-fetch dense candidates by cosine, then rerank
		// with an exact-term boost. Pure dense search on small embedding models
		// is unreliable for proper nouns — and TTRPG queries are mostly proper
		// nouns ("Ketgrinn", "Skitterdeep Mine", "the Weasel Hag") that the
		// embedding space has no meaningful neighborhood for.
		const candidateCount = Math.max(topK * RERANK_CANDIDATE_MULTIPLIER, RERANK_MIN_CANDIDATES)
		const candidates = await this.vectorStore.search(queryVector, candidateCount, filter)
		return rerankWithKeywordBoost(query, candidates, topK)
	}

	// ---- Build context for LLM from search results ----

	buildContext(results: SearchResult[]): string {
		if (results.length === 0) return ''

		const contextParts: string[] = ['## Relevant Campaign Information\n']

		// Group by document for cleaner output
		const byDoc = new Map<string, SearchResult[]>()
		for (const result of results) {
			const key = `${result.entry.documentType}:${result.entry.documentId}`
			if (!byDoc.has(key)) byDoc.set(key, [])
			byDoc.get(key)!.push(result)
		}

		for (const [, docResults] of byDoc) {
			const first = docResults[0].entry
			const typeLabel = first.documentType === 'journal' ? '📖' : '👤'
			contextParts.push(`### ${typeLabel} ${first.documentName} (${first.folderName})\n`)

			// Sort chunks by index for reading order
			docResults.sort((a, b) => a.entry.chunkIndex - b.entry.chunkIndex)

			for (const result of docResults) {
				contextParts.push(result.entry.text)
			}

			contextParts.push('')
		}

		return contextParts.join('\n')
	}

	// ---- Stats ----

	async getStats(): Promise<{
		totalVectors: number
		totalDocuments: number
		byType: Record<string, number>
	}> {
		if (!this.vectorStore) return { totalVectors: 0, totalDocuments: 0, byType: {} }
		return this.vectorStore.getStats()
	}

	// ---- Text Chunking ----

	private chunkText(text: string): string[] {
		if (!text || text.length === 0) return []

		// If text is small enough, return as single chunk
		if (text.length <= CHUNK_SIZE) return [text]

		const chunks: string[] = []
		let start = 0

		while (start < text.length) {
			let end = start + CHUNK_SIZE

			// Try to break at a sentence or paragraph boundary
			if (end < text.length) {
				// Look for paragraph break
				const paragraphBreak = text.lastIndexOf('\n\n', end)
				if (paragraphBreak > start + CHUNK_SIZE * 0.5) {
					end = paragraphBreak
				} else {
					// Look for sentence break
					const sentenceBreak = text.lastIndexOf('. ', end)
					if (sentenceBreak > start + CHUNK_SIZE * 0.5) {
						end = sentenceBreak + 1
					}
				}
			}

			chunks.push(text.slice(start, end).trim())

			// Move start forward with overlap
			start = end - CHUNK_OVERLAP
			if (start < 0) start = 0

			// Prevent infinite loop
			if (start >= text.length - 1) break
			if (chunks.length > 1000) break // safety valve
		}

		return chunks.filter((c) => c.length > 0)
	}

	// ---- Incremental Re-indexing ----

	async reindexDocument(documentId: string, documentType: 'journal' | 'actor'): Promise<void> {
		if (!this.vectorStore) {
			console.warn('FoundryAI | reindexDocument: embedding service not initialized, skipping')
			return
		}
		if (!openRouterService.isConfigured) {
			console.warn('FoundryAI | reindexDocument: OpenRouter not configured, skipping')
			return
		}

		try {
			const doc = this.extractSingleDocument(documentId, documentType)
			if (!doc) {
				await this.vectorStore.deleteByDocument(documentId)
				await this.vectorStore.deleteIndexMeta(documentId)
				console.log(`FoundryAI | reindexDocument: ${documentId} had no content, removed from index`)
				return
			}

			await this.vectorStore.deleteByDocument(documentId)

			const chunks = this.chunkText(doc.content)
			if (chunks.length === 0) {
				await this.vectorStore.deleteIndexMeta(documentId)
				return
			}

			const prefixes = embeddingTaskPrefixes()
			const embeddingResponse = await openRouterService.generateEmbeddings(chunks.map((c) => prefixes.doc + c))

			const vectorEntries: VectorEntry[] = chunks.map((text, idx) => ({
				id: `${doc.type}:${doc.id}:${idx}`,
				documentId: doc.id,
				documentType: doc.type,
				documentName: doc.name,
				folderName: doc.folderName,
				chunkIndex: idx,
				text,
				vector: embeddingResponse.data[idx].embedding,
				metadata: doc.metadata,
			}))
			await this.vectorStore.upsertVectors(vectorEntries)

			await this.vectorStore.setIndexMeta({
				documentId: doc.id,
				documentType: doc.type,
				documentName: doc.name,
				lastModified: doc.lastModified,
				chunkCount: chunks.length,
			})

			console.log(`FoundryAI | reindexDocument: re-indexed "${doc.name}" (${chunks.length} chunks)`)
		} catch (error: any) {
			console.error(`FoundryAI | reindexDocument failed for ${documentId}:`, error)
		}
	}

	private extractSingleDocument(documentId: string, documentType: 'journal' | 'actor'): ExtractedDocument | null {
		if (documentType === 'journal') {
			const entry = game.journal?.get(documentId)
			if (!entry || !entry.folder) return null
			const content = collectionReader.getJournalContent(documentId)
			if (!content) return null
			return {
				id: entry.id,
				name: entry.name,
				type: 'journal',
				folderId: entry.folder?.id || null,
				folderName: entry.folder?.name || 'Uncategorized',
				content,
				lastModified: Date.now(),
				metadata: { pageCount: entry.pages.size },
			}
		} else {
			const actor = game.actors?.get(documentId)
			if (!actor || !actor.folder) return null
			const content = collectionReader.getActorContent(documentId)
			if (!content) return null
			return {
				id: actor.id,
				name: actor.name,
				type: 'actor',
				folderId: actor.folder?.id || null,
				folderName: actor.folder?.name || 'Uncategorized',
				content,
				lastModified: Date.now(),
				metadata: {},
			}
		}
	}

	private reindexQueue = new Map<string, 'journal' | 'actor'>()
	private reindexTimer: ReturnType<typeof setTimeout> | null = null

	queueReindex(documentId: string, documentType: 'journal' | 'actor'): void {
		this.reindexQueue.set(documentId, documentType)
		if (this.reindexTimer) clearTimeout(this.reindexTimer)
		this.reindexTimer = setTimeout(() => {
			const queued = Array.from(this.reindexQueue.entries())
			this.reindexQueue.clear()
			this.reindexTimer = null
			for (const [id, type] of queued) {
				void this.reindexDocument(id, type)
			}
		}, 3000)
	}

	// ---- Cleanup ----

	async destroy(): Promise<void> {
		if (this.reindexTimer) clearTimeout(this.reindexTimer)
		this.vectorStore?.close()
		this.vectorStore = null
	}
}

// ---- Hybrid rerank helpers ----

/** Common words that carry no retrieval signal — kept deliberately small so we
 *  never accidentally filter a campaign term. */
const QUERY_STOPWORDS = new Set([
	'the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'to', 'is', 'are', 'was', 'were',
	'what', 'who', 'where', 'when', 'how', 'why', 'tell', 'me', 'about', 'for', 'with',
	'at', 'it', 'this', 'that', 'do', 'does', 'did', 'can', 'you', 'i', 'we', 'they',
])

/** Meaningful search terms from a natural-language query. */
function extractQueryTerms(query: string): string[] {
	const tokens = query.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) || []
	return [...new Set(tokens.filter(t => !QUERY_STOPWORDS.has(t)))]
}

/**
 * Boost dense-retrieval candidates that literally contain the query's terms.
 * Weights are calibrated so keyword hits act as a tiebreaker/booster on top of
 * cosine (typical spread ~0.2–0.6), not a replacement for it: full term
 * coverage adds up to +0.15, and a term matching the DOCUMENT NAME (asking
 * about "the Weasel Hag" should surface the Weasel Hag's own entry above a
 * passing mention) adds +0.05 more.
 */
function rerankWithKeywordBoost(query: string, candidates: SearchResult[], topK: number): SearchResult[] {
	const terms = extractQueryTerms(query)
	if (terms.length === 0 || candidates.length === 0) return candidates.slice(0, topK)

	for (const candidate of candidates) {
		const name = candidate.entry.documentName.toLowerCase()
		const haystack = `${name} ${candidate.entry.text.toLowerCase()}`

		let hits = 0
		let nameHit = false
		for (const term of terms) {
			if (haystack.includes(term)) hits++
			if (name.includes(term)) nameHit = true
		}

		candidate.score += (hits / terms.length) * 0.15 + (nameHit ? 0.05 : 0)
	}

	candidates.sort((a, b) => b.score - a.score)
	return candidates.slice(0, topK)
}

export const embeddingService = new EmbeddingService()
