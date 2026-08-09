import { describe, it, expect } from 'vitest';
import {
	parseFrontmatterField,
	parseFrontmatter,
	normalizeCitationPath,
	extractCitations,
	tokenizeForSearch,
	estimateTokens,
	estimateGeminiCost
} from './utils';

// ─── parseFrontmatterField ─────────────────────────────────────────

describe('parseFrontmatterField', () => {
	it('extracts a simple field', () => {
		const content = '---\ntitle: My Note\nrecord_kind: event\n---\nBody text';
		expect(parseFrontmatterField(content, 'record_kind')).toBe('event');
	});

	it('returns null when field is missing', () => {
		const content = '---\ntitle: My Note\n---\nBody text';
		expect(parseFrontmatterField(content, 'record_kind')).toBeNull();
	});

	it('returns null when no frontmatter exists', () => {
		expect(parseFrontmatterField('Just a note', 'title')).toBeNull();
	});

	it('handles extra spaces around value', () => {
		const content = '---\nrecord_kind:   thought  \n---\n';
		expect(parseFrontmatterField(content, 'record_kind')).toBe('thought');
	});

	it('does not match field in body text', () => {
		const content = '---\ntitle: Test\n---\nrecord_kind: event';
		expect(parseFrontmatterField(content, 'record_kind')).toBeNull();
	});

	it('handles multi-line frontmatter correctly', () => {
		const content = '---\ndate: 2025-01-01\nsource_capture_id: abc-123\ntags: daily\n---\nContent';
		expect(parseFrontmatterField(content, 'source_capture_id')).toBe('abc-123');
		expect(parseFrontmatterField(content, 'date')).toBe('2025-01-01');
		expect(parseFrontmatterField(content, 'tags')).toBe('daily');
	});
});

// ─── parseFrontmatter ──────────────────────────────────────────────

describe('parseFrontmatter', () => {
	it('parses all key-value pairs', () => {
		const content = '---\ntitle: My Note\nrecord_kind: idea\ndate: 2025-01-01\n---\nBody';
		const result = parseFrontmatter(content);
		expect(result).toEqual({
			title: 'My Note',
			record_kind: 'idea',
			date: '2025-01-01'
		});
	});

	it('returns empty object for no frontmatter', () => {
		expect(parseFrontmatter('No frontmatter here')).toEqual({});
	});

	it('skips lines without colon', () => {
		const content = '---\ntitle: Test\ninvalid line\ndate: 2025\n---\n';
		const result = parseFrontmatter(content);
		expect(result).toEqual({ title: 'Test', date: '2025' });
	});

	it('handles empty values', () => {
		const content = '---\ntitle: \ndate: 2025\n---\n';
		const result = parseFrontmatter(content);
		expect(result).toEqual({ date: '2025' });
	});
});

// ─── normalizeCitationPath ─────────────────────────────────────────

describe('normalizeCitationPath', () => {
	it('normalizes backslashes to forward slashes', () => {
		expect(normalizeCitationPath('folder\\sub\\file.md')).toBe('folder/sub/file.md');
	});

	it('removes leading slashes', () => {
		expect(normalizeCitationPath('/folder/file.md')).toBe('folder/file.md');
	});

	it('lowercases the path', () => {
		expect(normalizeCitationPath('Folder/My Note.md')).toBe('folder/my note.md');
	});

	it('handles mixed separators', () => {
		expect(normalizeCitationPath('\\folder/Sub\\file.MD')).toBe('folder/sub/file.md');
	});
});

// ─── extractCitations ──────────────────────────────────────────────

describe('extractCitations', () => {
	it('extracts Source references', () => {
		const text = 'Based on [Source: notes/daily.md] and [Source: ideas/project.md]';
		const result = extractCitations(text);
		expect(result).toHaveLength(2);
		expect(result[0].sourcePath).toBe('notes/daily.md');
		expect(result[1].sourcePath).toBe('ideas/project.md');
	});

	it('deduplicates same source', () => {
		const text = '[Source: note.md] mentioned again [Source: note.md]';
		expect(extractCitations(text)).toHaveLength(1);
	});

	it('returns empty for no citations', () => {
		expect(extractCitations('Just plain text')).toEqual([]);
	});

	it('handles quoted paths', () => {
		const text = '[Source: "my note.md"]';
		const result = extractCitations(text);
		expect(result[0].sourcePath).toBe('my note.md');
	});

	it('ignores regular wiki links', () => {
		const text = '[[Some Note]] is referenced but [Source: real.md]';
		const result = extractCitations(text);
		expect(result).toHaveLength(1);
		expect(result[0].sourcePath).toBe('real.md');
	});
});

// ─── tokenizeForSearch ─────────────────────────────────────────────

describe('tokenizeForSearch', () => {
	it('tokenizes English text', () => {
		const tokens = tokenizeForSearch('How to configure Obsidian sync');
		expect(tokens).toContain('how');
		expect(tokens).toContain('configure');
		expect(tokens).toContain('obsidian');
		expect(tokens).toContain('sync');
	});

	it('filters stop words', () => {
		const tokens = tokenizeForSearch('the best way for you');
		expect(tokens).not.toContain('the');
		expect(tokens).not.toContain('for');
		expect(tokens).not.toContain('you');
		expect(tokens).toContain('best');
		expect(tokens).toContain('way');
	});

	it('filters Korean stop words', () => {
		const tokens = tokenizeForSearch('노트 활용에 대한 방법');
		expect(tokens).not.toContain('노트');
		expect(tokens).not.toContain('활용');
		expect(tokens).not.toContain('대한');
		expect(tokens).toContain('방법');
	});

	it('filters pure numbers', () => {
		const tokens = tokenizeForSearch('step 123 process');
		expect(tokens).not.toContain('123');
		expect(tokens).toContain('step');
		expect(tokens).toContain('process');
	});

	it('filters single characters', () => {
		const tokens = tokenizeForSearch('a b cd ef');
		expect(tokens).not.toContain('a');
		expect(tokens).not.toContain('b');
		expect(tokens).toContain('cd');
		expect(tokens).toContain('ef');
	});

	it('caps at 32 tokens', () => {
		const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
		const tokens = tokenizeForSearch(longText);
		expect(tokens.length).toBeLessThanOrEqual(32);
	});

	it('strips punctuation', () => {
		const tokens = tokenizeForSearch('hello, world! test?');
		expect(tokens).toContain('hello');
		expect(tokens).toContain('world');
		expect(tokens).toContain('test');
	});

	it('deduplicates tokens', () => {
		const tokens = tokenizeForSearch('test test test unique');
		expect(tokens.filter(t => t === 'test')).toHaveLength(1);
	});
});

// ─── estimateTokens ────────────────────────────────────────────────

describe('estimateTokens', () => {
	it('estimates roughly 1 token per 4 chars', () => {
		expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 → 3
	});

	it('returns minimum 1 for empty string', () => {
		expect(estimateTokens('')).toBe(1);
	});

	it('handles Korean text', () => {
		const korean = '한국어 텍스트입니다';
		expect(estimateTokens(korean)).toBeGreaterThan(0);
	});

	it('handles long text', () => {
		const longText = 'a'.repeat(1000);
		expect(estimateTokens(longText)).toBe(250);
	});
});

// ─── estimateGeminiCost ────────────────────────────────────────────

describe('estimateGeminiCost', () => {
	it('calculates flash model cost', () => {
		const cost = estimateGeminiCost('gemini-2.5-flash', 1000, 500);
		expect(cost).toBeCloseTo((1000 / 1_000_000) * 0.3 + (500 / 1_000_000) * 2.5, 6);
		expect(cost).toBeGreaterThan(0);
	});

	it('calculates lite model cost (cheapest)', () => {
		const costLite = estimateGeminiCost('gemini-lite', 1_000_000, 1_000_000);
		const costFlash = estimateGeminiCost('gemini-flash', 1_000_000, 1_000_000);
		expect(costLite).toBeLessThan(costFlash);
	});

	it('calculates pro model cost (most expensive)', () => {
		const costPro = estimateGeminiCost('gemini-pro', 1_000_000, 1_000_000);
		const costFlash = estimateGeminiCost('gemini-flash', 1_000_000, 1_000_000);
		expect(costPro).toBeGreaterThan(costFlash);
	});

	it('returns 0 for zero tokens', () => {
		expect(estimateGeminiCost('gemini-flash', 0, 0)).toBe(0);
	});

	it('handles 1M tokens pricing correctly', () => {
		const cost = estimateGeminiCost('gemini-2.5-flash', 1_000_000, 1_000_000);
		expect(cost).toBeCloseTo(0.3 + 2.5, 2);
	});
});
