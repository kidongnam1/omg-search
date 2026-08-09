export function parseFrontmatterField(content: string, field: string): string | null {
	const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!fmMatch) return null;
	const pattern = new RegExp(`^${field}:\\s*(.+)`, 'm');
	const match = fmMatch[1].match(pattern);
	return match ? match[1].trim() : null;
}

export function parseFrontmatter(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) return result;
	for (const line of match[1].split('\n')) {
		const sep = line.indexOf(':');
		if (sep < 0) continue;
		const key = line.slice(0, sep).trim();
		const val = line.slice(sep + 1).trim();
		if (key && val) result[key] = val;
	}
	return result;
}

export function normalizeCitationPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

export function extractCitations(text: string): { sourceId: string; sourcePath: string; content: string }[] {
	const citations: { sourceId: string; sourcePath: string; content: string }[] = [];
	const pattern = /\[Source:\s*([^\]]+)\]/g;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const sourcePath = (match[1] || '').trim().replace(/^["']|["']$/g, '');
		if (sourcePath && !citations.find(c => c.sourcePath === sourcePath)) {
			citations.push({ sourceId: sourcePath, sourcePath, content: '' });
		}
	}
	return citations;
}

const STOP_TOKENS = new Set([
	'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your',
	'are', 'was', 'were', 'have', 'has', 'not', 'can', 'will',
	'대한', '관련', '작성', '내용', '노트', '활용', '사용자', '초안',
	'있습니다', '합니다', '위한', '에게', '에서', '으로', '그리고'
]);

export function tokenizeForSearch(text: string): string[] {
	const tokens = new Set<string>();
	const normalized = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ');

	for (const raw of normalized.split(/\s+/)) {
		const token = raw.trim();
		if (token.length < 2) continue;
		if (/^\d+$/.test(token)) continue;
		if (STOP_TOKENS.has(token)) continue;
		tokens.add(token);
		if (tokens.size >= 32) break;
	}

	return Array.from(tokens);
}

export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateGeminiCost(
	model: string,
	inputTokens: number,
	outputTokens: number
): number {
	let inputRate = 0.3;
	let outputRate = 2.5;
	if (model.includes('lite')) { inputRate = 0.1; outputRate = 0.4; }
	else if (model.includes('pro')) { inputRate = 1.25; outputRate = 10; }

	return Number((
		(inputTokens / 1_000_000) * inputRate +
		(outputTokens / 1_000_000) * outputRate
	).toFixed(6));
}
