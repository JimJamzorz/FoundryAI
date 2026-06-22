// Campaign Management — FoundryAI browser module
// Generates campaign dashboard HTML for use with create_campaign_dashboard tool

type CampaignPartType = 'main_part' | 'sub_part' | 'chapter' | 'session' | 'optional'
type CampaignStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped'

interface CampaignSubPart {
	id: string
	title: string
	description: string
	type: CampaignPartType
	status: CampaignStatus
	createdAt: number
	journalId?: string
}

interface CampaignPart {
	id: string
	title: string
	description: string
	type: CampaignPartType
	status: CampaignStatus
	dependencies: string[]
	subParts?: CampaignSubPart[]
	questGiver?: { id: string; name: string }
	levelRecommendation: { start: number; end: number }
	gmNotes: string
	playerContent: string
	scaling: { adjustForPartySize: boolean; adjustForLevel: boolean; difficultyModifier: number }
	createdAt: number
	journalId?: string
}

interface CampaignStructure {
	id: string
	title: string
	description: string
	parts: CampaignPart[]
	metadata: {
		defaultQuestGiver?: { id: string; name: string }
		defaultLocation?: string
		theme?: string
		tags: string[]
	}
	createdAt: number
	updatedAt: number
}

export interface CampaignDashboardArgs {
	campaign_title: string
	campaign_description: string
	template: 'five-part-adventure' | 'dungeon-crawl' | 'investigation' | 'sandbox' | 'custom'
	custom_parts?: Array<{
		title: string
		description: string
		type: CampaignPartType
		level_start: number
		level_end: number
		sub_parts?: Array<{ title: string; description: string }>
	}>
	default_quest_giver?: string
	default_location?: string
}

export function generateCampaignDashboardHTML(args: CampaignDashboardArgs): {
	html: string
	campaignId: string
	partCount: number
} {
	if (!args.campaign_title?.trim()) throw new Error('campaign_title is required')
	if (!args.campaign_description?.trim()) throw new Error('campaign_description is required')
	if (!args.template) throw new Error('template is required')

	const validTemplates = ['five-part-adventure', 'dungeon-crawl', 'investigation', 'sandbox', 'custom']
	if (!validTemplates.includes(args.template)) {
		throw new Error(`Invalid template "${args.template}". Must be one of: ${validTemplates.join(', ')}`)
	}

	// Map snake_case tool args to internal camelCase request shape
	const request = {
		campaignTitle: args.campaign_title,
		campaignDescription: args.campaign_description,
		template: args.template,
		customParts: args.custom_parts?.map(p => ({
			title: p.title,
			description: p.description,
			type: p.type,
			levelStart: p.level_start,
			levelEnd: p.level_end,
			subParts: p.sub_parts,
		})),
		defaultQuestGiver: args.default_quest_giver,
		defaultLocation: args.default_location,
	}

	console.log(`FoundryAI | campaign: generating dashboard for "${request.campaignTitle}" using template "${request.template}"`)

	const campaign = generateCampaignStructure(request)
	const html = generateDashboardHTML(campaign)

	console.log(`FoundryAI | campaign: dashboard HTML generated, ${campaign.parts.length} parts`)

	return { html, campaignId: campaign.id, partCount: campaign.parts.length }
}

function generateCampaignStructure(request: any): CampaignStructure {
	const campaignId = `campaign-${Date.now()}`
	const timestamp = Date.now()

	let parts: CampaignPart[]

	if (request.template === 'custom' && request.customParts) {
		parts = request.customParts.map((part: any, index: number) => ({
			id: `${campaignId}-part-${index + 1}`,
			title: part.title,
			description: part.description,
			type: part.type,
			status: 'not_started' as const,
			dependencies: index > 0 ? [`${campaignId}-part-${index}`] : [],
			subParts: part.subParts?.map((subPart: any, subIndex: number) => ({
				id: `${campaignId}-part-${index + 1}-sub-${subIndex + 1}`,
				title: subPart.title,
				description: subPart.description,
				type: 'sub_part' as const,
				status: 'not_started' as const,
				createdAt: timestamp,
			})),
			...(request.defaultQuestGiver && {
				questGiver: {
					id: `npc-${request.defaultQuestGiver.toLowerCase().replace(/\s+/g, '-')}`,
					name: request.defaultQuestGiver,
				},
			}),
			levelRecommendation: {
				start: part.levelStart,
				end: part.levelEnd,
			},
			gmNotes: '',
			playerContent: '',
			scaling: {
				adjustForPartySize: true,
				adjustForLevel: true,
				difficultyModifier: 0,
			},
			createdAt: timestamp,
		}))
	} else {
		parts = getTemplateParts(request.template, campaignId, timestamp, request.defaultQuestGiver)
	}

	return {
		id: campaignId,
		title: request.campaignTitle,
		description: request.campaignDescription,
		parts,
		metadata: {
			...(request.defaultQuestGiver && {
				defaultQuestGiver: {
					id: `npc-${request.defaultQuestGiver.toLowerCase().replace(/\s+/g, '-')}`,
					name: request.defaultQuestGiver,
				},
			}),
			...(request.defaultLocation && { defaultLocation: request.defaultLocation }),
			...(request.template && { theme: request.template }),
			tags: [request.template],
		},
		createdAt: timestamp,
		updatedAt: timestamp,
	}
}

function getTemplateParts(
	template: string,
	campaignId: string,
	timestamp: number,
	defaultQuestGiver?: string,
): CampaignPart[] {
	const templates: Record<string, any[]> = {
		'five-part-adventure': [
			{
				title: 'Hook & Introduction',
				description: 'Draw the party into the adventure with compelling hooks and initial encounters',
				levels: [1, 2],
			},
			{
				title: 'Investigation & Clues',
				description: 'Gather information, explore leads, and uncover the scope of the threat',
				levels: [2, 4],
			},
			{
				title: 'Midpoint Revelation',
				description: 'Major discovery or plot twist that changes the stakes and direction',
				levels: [4, 6],
			},
			{
				title: 'Climactic Confrontation',
				description: 'Face the primary antagonist or overcome the central challenge',
				levels: [6, 8],
			},
			{
				title: 'Resolution & Rewards',
				description: 'Wrap up loose ends, distribute rewards, and set up future adventures',
				levels: [8, 9],
			},
		],
		'dungeon-crawl': [
			{
				title: 'Approach & Entry',
				description: 'Navigate to the dungeon and overcome entrance challenges',
				levels: [1, 2],
			},
			{
				title: 'Upper Levels',
				description: 'Explore the first floors, encounter guardians and traps',
				levels: [2, 4],
				subParts: [
					{ title: 'Rooms 1-3', description: 'Initial chambers and encounters' },
					{ title: 'Rooms 4-6', description: 'Mid-level challenges and treasures' },
				],
			},
			{
				title: 'Lower Levels',
				description: 'Delve deeper into more dangerous areas',
				levels: [4, 6],
				subParts: [
					{ title: 'Rooms 7-9', description: 'Advanced traps and stronger enemies' },
					{ title: 'Rooms 10-12', description: 'Elite encounters and hidden secrets' },
				],
			},
			{
				title: 'Final Boss & Treasure',
				description: "Confront the dungeon's master and claim the ultimate prize",
				levels: [6, 8],
			},
		],
		investigation: [
			{
				title: 'Crime Scene',
				description: 'Initial investigation of the incident and evidence gathering',
				levels: [1, 2],
			},
			{
				title: 'Witness Interviews',
				description: 'Question involved parties and gather testimonies',
				levels: [2, 3],
				subParts: [
					{ title: 'Primary Witnesses', description: 'Key individuals with direct knowledge' },
					{ title: 'Secondary Sources', description: 'Additional contacts and informants' },
				],
			},
			{
				title: 'Following Leads',
				description: 'Pursue clues to multiple locations and uncover connections',
				levels: [3, 5],
				subParts: [
					{ title: 'Location A', description: 'First lead destination' },
					{ title: 'Location B', description: 'Second investigation site' },
					{ title: 'Location C', description: 'Final clue location' },
				],
			},
			{
				title: 'Confrontation',
				description: 'Face the culprit with evidence and resolve the case',
				levels: [5, 6],
			},
			{
				title: 'Resolution',
				description: 'Tie up loose ends and deliver justice or closure',
				levels: [6, 7],
			},
		],
		sandbox: [
			{
				title: 'World Introduction',
				description: 'Establish the setting, key NPCs, and available opportunities',
				levels: [1, 3],
			},
			{
				title: 'Exploration Phase',
				description: 'Players choose their path and explore available content',
				levels: [3, 8],
			},
			{
				title: 'Consequences & Reactions',
				description: 'World responds to player actions with new challenges',
				levels: [8, 12],
			},
			{
				title: 'Player-Driven Climax',
				description: 'Major storyline chosen and pursued by players',
				levels: [12, 15],
			},
		],
	}

	const templateParts = templates[template] || templates['five-part-adventure']

	return templateParts.map((part, index) => ({
		id: `${campaignId}-part-${index + 1}`,
		title: part.title,
		description: part.description,
		type: 'main_part' as const,
		status: 'not_started' as const,
		dependencies: index > 0 ? [`${campaignId}-part-${index}`] : [],
		subParts: part.subParts?.map((subPart: any, subIndex: number) => ({
			id: `${campaignId}-part-${index + 1}-sub-${subIndex + 1}`,
			title: subPart.title,
			description: subPart.description,
			type: 'sub_part' as const,
			status: 'not_started' as const,
			createdAt: timestamp,
		})),
		...(defaultQuestGiver && {
			questGiver: {
				id: `npc-${defaultQuestGiver.toLowerCase().replace(/\s+/g, '-')}`,
				name: defaultQuestGiver,
			},
		}),
		levelRecommendation: {
			start: part.levels[0],
			end: part.levels[1],
		},
		gmNotes: '',
		playerContent: '',
		scaling: {
			adjustForPartySize: true,
			adjustForLevel: true,
			difficultyModifier: 0,
		},
		createdAt: timestamp,
	}))
}

function generateDashboardHTML(campaign: CampaignStructure): string {
	const progress = calculateProgress(campaign)
	const currentPart = campaign.parts.find(part => part.status === 'in_progress')

	return `<style>
.campaign-status-toggle {
  cursor: pointer;
  border-radius: 1em;
  padding: 0.3em 0.6em;
  margin: 0 0.2em;
  font-size: 0.9em;
  font-weight: bold;
  color: #fff;
  background: #777;
  border: 1px solid #555;
  transition: all 0.2s ease;
  display: inline-block;
  user-select: none;
}

.campaign-status-toggle:hover {
  transform: scale(1.05);
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
}

.campaign-status-toggle.not-started {
  background: #6c757d;
  border-color: #495057;
}

.campaign-status-toggle.in-progress {
  background: #007bff;
  border-color: #0056b3;
}

.campaign-status-toggle.completed {
  background: #28a745;
  border-color: #1e7e34;
}

.campaign-status-toggle.skipped {
  background: #ffc107;
  border-color: #e0a800;
  color: #212529;
}

.campaign-part {
  margin-bottom: 1.5em;
  padding: 1em;
  border-left: 4px solid #ddd;
}

.campaign-part.in-progress {
  border-left-color: #007bff;
  background: rgba(0, 123, 255, 0.05);
}

.campaign-part.completed {
  border-left-color: #28a745;
  background: rgba(40, 167, 69, 0.05);
}
</style>

<div class="campaign-dashboard spaced">
  <h1>${campaign.title}</h1>

  <div class="campaign-overview readaloud">
    <p><strong>Campaign Progress:</strong> ${progress.completed} of ${progress.total} parts completed (${progress.percentage}%)</p>
    <p><strong>Current Focus:</strong> ${currentPart ? currentPart.title : 'Ready to begin'}</p>
    ${campaign.metadata.defaultLocation ? `<p><strong>Primary Setting:</strong> ${campaign.metadata.defaultLocation}</p>` : ''}
    ${campaign.metadata.defaultQuestGiver ? `<p><strong>Primary Quest Giver:</strong> ${campaign.metadata.defaultQuestGiver.name}</p>` : ''}
  </div>

  <h2>Campaign Parts</h2>
  <p><em>Click status indicators to update progress. Changes are saved automatically.</em></p>

  ${campaign.parts.map((part, index) => generatePartHTML(part, index + 1, campaign)).join('\n  ')}

  <div class="campaign-notes gmnote">
    <h3>GM Notes</h3>
    <p><em>Campaign created: ${new Date(campaign.createdAt).toLocaleDateString()}</em></p>
    <p><em>Last updated: ${new Date(campaign.updatedAt).toLocaleDateString()}</em></p>
    ${campaign.description ? `<p><strong>Description:</strong> ${campaign.description}</p>` : ''}
    <p><em><strong>Campaign ID:</strong> ${campaign.id}</em></p>
  </div>
</div>`
}

function generatePartHTML(part: CampaignPart, partNumber: number, campaign: CampaignStructure): string {
	const isLocked = isPartLocked(part, campaign)
	const lockIcon = isLocked ? '[LOCKED] ' : ''
	const statusTracker = generateStatusTracker(part, campaign.id)

	let html = `<div class="campaign-part ${part.status} spaced">
    <h3>${lockIcon}Part ${partNumber}: ${part.title}</h3>
    <p><strong>Status:</strong> ${statusTracker}</p>
    <p><strong>Levels:</strong> ${part.levelRecommendation.start}-${part.levelRecommendation.end}</p>`

	if (part.journalId) {
		html += `\n    <p><strong>@JournalEntry[${part.journalId}]{📖 View Details}</strong></p>`
	}

	html += `\n    <p>${part.description}</p>`

	if (isLocked && part.dependencies.length > 0) {
		const depNames = part.dependencies
			.map(depId => {
				const depPart = campaign.parts.find(p => p.id === depId)
				return depPart ? depPart.title : depId
			})
			.join(', ')
		html += `\n    <p class="dependencies"><small><em>Requires completion of:</em> ${depNames}</small></p>`
	}

	if (part.subParts && part.subParts.length > 0) {
		html += `\n    <div class="sub-parts">`
		html += `\n      <h4>Sub-Parts:</h4>`
		part.subParts.forEach((subPart, subIndex) => {
			const subStatusTracker = generateStatusTracker(subPart, campaign.id)
			html += `\n      <p><strong>${partNumber}.${subIndex + 1}: ${subPart.title}</strong> - Status: ${subStatusTracker}</p>`
			if (subPart.journalId) {
				html += `\n      <p><strong>@JournalEntry[${subPart.journalId}]{📖 View Details}</strong></p>`
			}
			html += `\n      <hr style="margin: 10px 0; border: 1px solid #ccc;">`
		})
		html += `\n    </div>`
	}

	html += `\n  </div>`

	return html
}

function generateStatusTracker(part: CampaignPart | CampaignSubPart, campaignId: string): string {
	const statusIcon = getStatusIcon(part.status)
	const statusDisplay = formatStatus(part.status)
	const statusClass = part.status.replace('_', '-')

	return `<span class="campaign-status-toggle ${statusClass}"
                  data-campaign-id="${campaignId}"
                  data-part-id="${part.id}"
                  title="Click to change status: ${statusDisplay}">
              ${statusIcon} ${statusDisplay}
            </span>`
}

function getStatusIcon(status: string): string {
	const icons: Record<string, string> = {
		not_started: '⚪',
		in_progress: '🔄',
		completed: '✅',
		skipped: '⏭️',
	}
	return icons[status] || '❓'
}

function formatStatus(status: string): string {
	return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

function isPartLocked(part: CampaignPart, campaign: CampaignStructure): boolean {
	if (part.dependencies.length === 0) return false
	return part.dependencies.some(depId => {
		const depPart = campaign.parts.find(p => p.id === depId)
		return !depPart || depPart.status !== 'completed'
	})
}

function calculateProgress(campaign: CampaignStructure): { total: number; completed: number; percentage: number } {
	let total = 0
	let completed = 0

	campaign.parts.forEach(part => {
		if (part.subParts && part.subParts.length > 0) {
			total += part.subParts.length
			completed += part.subParts.filter(sp => sp.status === 'completed').length
		} else {
			total += 1
			if (part.status === 'completed') completed += 1
		}
	})

	const percentage = total > 0 ? Math.round((completed / total) * 100) : 0

	return { total, completed, percentage }
}
