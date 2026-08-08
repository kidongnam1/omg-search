import { Notice } from 'obsidian';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import GeminiSyncPlugin from './main';

export interface WikiStatusResult {
	installed: boolean;
	vaultConfigured: boolean;
	vaultPath: string;
	cliPath: string;
	pageCount: number;
	categories: string[];
	hasManifest: boolean;
	hasIndex: boolean;
	error?: string;
}

export interface WikiQueryResult {
	answer: string;
	sources: string[];
	error?: string;
}

export interface WikiLintResult {
	ok: boolean;
	checks: WikiLintCheck[];
	summary: string;
	error?: string;
}

export interface WikiLintCheck {
	name: string;
	status: 'pass' | 'fail' | 'warn';
	message: string;
	items?: string[];
}

export interface WikiIngestResult {
	ok: boolean;
	pagesCreated: number;
	pagesUpdated: number;
	message: string;
	error?: string;
}

export class WikiService {
	private activeChild: ChildProcessWithoutNullStreams | null = null;

	constructor(private plugin: GeminiSyncPlugin) {}

	stop(): boolean {
		if (!this.activeChild) return false;
		this.activeChild.kill();
		this.activeChild = null;
		return true;
	}

	resolveCliPath(): string | null {
		const configured = this.plugin.settings.wikiCliPath?.trim();
		if (configured && configured !== 'obsidian-wiki') {
			if (existsSync(configured)) return configured;
		}

		const candidates = [
			'obsidian-wiki',
			join(homedir(), '.local', 'bin', 'obsidian-wiki'),
			join(homedir(), '.cargo', 'bin', 'obsidian-wiki'),
			'/usr/local/bin/obsidian-wiki',
			'/opt/homebrew/bin/obsidian-wiki',
		];

		if (process.platform === 'win32') {
			const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
			candidates.push(
				join(localAppData, 'Programs', 'Python', 'Scripts', 'obsidian-wiki.exe'),
				join(homedir(), 'AppData', 'Roaming', 'Python', 'Scripts', 'obsidian-wiki.exe'),
			);
		}

		const pathDirs = (process.env.PATH || '').split(delimiter);
		const exe = process.platform === 'win32' ? 'obsidian-wiki.exe' : 'obsidian-wiki';
		for (const dir of pathDirs) {
			const full = join(dir, exe);
			if (existsSync(full)) return full;
		}

		for (const c of candidates) {
			if (existsSync(c)) return c;
		}

		return null;
	}

	async checkInstallation(): Promise<WikiStatusResult> {
		const cliPath = this.resolveCliPath();
		const vaultPath = this.getWikiVaultPath();
		const result: WikiStatusResult = {
			installed: false,
			vaultConfigured: !!vaultPath,
			vaultPath: vaultPath || '',
			cliPath: cliPath || '',
			pageCount: 0,
			categories: [],
			hasManifest: false,
			hasIndex: false,
		};

		if (!cliPath) {
			result.error = 'obsidian-wiki CLI not found. Install with: pip install obsidian-wiki';
			return result;
		}

		result.installed = true;

		try {
			const output = await this.exec(cliPath, ['doctor'], 10000);
			if (output.exitCode === 0) {
				result.installed = true;
			}
		} catch {
			result.error = 'obsidian-wiki doctor check failed';
		}

		if (vaultPath) {
			const vault = this.plugin.app.vault;
			result.hasManifest = !!vault.getAbstractFileByPath('.manifest.json');
			result.hasIndex = !!vault.getAbstractFileByPath('index.md');

			const categories = ['concepts', 'entities', 'skills', 'references', 'synthesis', 'journal', 'projects'];
			result.categories = categories.filter(c => !!vault.getAbstractFileByPath(c));

			let count = 0;
			for (const cat of result.categories) {
				const folder = vault.getAbstractFileByPath(cat);
				if (folder && 'children' in folder) {
					count += (folder as any).children.filter((f: any) => f.extension === 'md').length;
				}
			}
			result.pageCount = count;
		}

		return result;
	}

	async runQuery(query: string): Promise<WikiQueryResult> {
		const cliPath = this.resolveCliPath();
		if (!cliPath) {
			return { answer: '', sources: [], error: 'obsidian-wiki CLI not found' };
		}

		const vaultPath = this.getWikiVaultPath();
		if (!vaultPath) {
			return { answer: '', sources: [], error: 'Wiki vault path not configured' };
		}

		try {
			const output = await this.exec(cliPath, ['query', query], 30000, { OBSIDIAN_VAULT_PATH: vaultPath });
			const sources: string[] = [];
			const lines = output.stdout.split('\n');
			for (const line of lines) {
				const match = line.match(/\[\[([^\]]+)\]\]/g);
				if (match) {
					sources.push(...match.map(m => m.replace(/^\[\[|\]\]$/g, '')));
				}
			}
			return {
				answer: output.stdout.trim(),
				sources: [...new Set(sources)],
				error: output.exitCode !== 0 ? output.stderr.trim() : undefined,
			};
		} catch (error: any) {
			return { answer: '', sources: [], error: error?.message || 'Query failed' };
		}
	}

	async runLint(): Promise<WikiLintResult> {
		const cliPath = this.resolveCliPath();
		if (!cliPath) {
			return { ok: false, checks: [], summary: '', error: 'obsidian-wiki CLI not found' };
		}

		const vaultPath = this.getWikiVaultPath();
		if (!vaultPath) {
			return { ok: false, checks: [], summary: '', error: 'Wiki vault path not configured' };
		}

		try {
			const output = await this.exec(cliPath, ['lint'], 30000, { OBSIDIAN_VAULT_PATH: vaultPath });
			const checks: WikiLintCheck[] = [];
			let currentCheck: WikiLintCheck | null = null;

			for (const line of output.stdout.split('\n')) {
				const passMatch = line.match(/^\s*(PASS|OK|✓)\s+(.+)/i);
				const failMatch = line.match(/^\s*(FAIL|ERROR|✗|✘)\s+(.+)/i);
				const warnMatch = line.match(/^\s*(WARN|WARNING|⚠)\s+(.+)/i);

				if (passMatch) {
					currentCheck = { name: passMatch[2].trim(), status: 'pass', message: passMatch[2].trim() };
					checks.push(currentCheck);
				} else if (failMatch) {
					currentCheck = { name: failMatch[2].trim(), status: 'fail', message: failMatch[2].trim(), items: [] };
					checks.push(currentCheck);
				} else if (warnMatch) {
					currentCheck = { name: warnMatch[2].trim(), status: 'warn', message: warnMatch[2].trim(), items: [] };
					checks.push(currentCheck);
				} else if (currentCheck && currentCheck.items && line.trim().startsWith('-')) {
					currentCheck.items.push(line.trim().slice(1).trim());
				}
			}

			const failCount = checks.filter(c => c.status === 'fail').length;
			const warnCount = checks.filter(c => c.status === 'warn').length;
			const passCount = checks.filter(c => c.status === 'pass').length;

			return {
				ok: failCount === 0,
				checks,
				summary: `${passCount} passed, ${warnCount} warnings, ${failCount} failed`,
				error: output.exitCode !== 0 ? output.stderr.trim() : undefined,
			};
		} catch (error: any) {
			return { ok: false, checks: [], summary: '', error: error?.message || 'Lint failed' };
		}
	}

	async runIngest(sourcePath: string): Promise<WikiIngestResult> {
		const cliPath = this.resolveCliPath();
		if (!cliPath) {
			return { ok: false, pagesCreated: 0, pagesUpdated: 0, message: '', error: 'obsidian-wiki CLI not found' };
		}

		const vaultPath = this.getWikiVaultPath();
		if (!vaultPath) {
			return { ok: false, pagesCreated: 0, pagesUpdated: 0, message: '', error: 'Wiki vault path not configured' };
		}

		try {
			const output = await this.exec(cliPath, ['cache-check', sourcePath], 60000, { OBSIDIAN_VAULT_PATH: vaultPath });
			let created = 0;
			let updated = 0;

			for (const line of output.stdout.split('\n')) {
				const createMatch = line.match(/created?\s*:?\s*(\d+)/i);
				const updateMatch = line.match(/updated?\s*:?\s*(\d+)/i);
				if (createMatch) created = parseInt(createMatch[1]);
				if (updateMatch) updated = parseInt(updateMatch[1]);
			}

			return {
				ok: output.exitCode === 0,
				pagesCreated: created,
				pagesUpdated: updated,
				message: output.stdout.trim(),
				error: output.exitCode !== 0 ? output.stderr.trim() : undefined,
			};
		} catch (error: any) {
			return { ok: false, pagesCreated: 0, pagesUpdated: 0, message: '', error: error?.message || 'Ingest failed' };
		}
	}

	async runSetup(): Promise<{ ok: boolean; message: string }> {
		const cliPath = this.resolveCliPath();
		if (!cliPath) {
			return { ok: false, message: 'obsidian-wiki CLI not found. Install with: pip install obsidian-wiki' };
		}

		const vaultPath = this.getWikiVaultPath();
		if (!vaultPath) {
			return { ok: false, message: 'Wiki vault path not configured. Set it in settings.' };
		}

		try {
			const output = await this.exec(cliPath, ['setup', '--vault', vaultPath], 30000);
			return {
				ok: output.exitCode === 0,
				message: output.exitCode === 0
					? 'Wiki vault initialized successfully.'
					: output.stderr.trim() || 'Setup failed.',
			};
		} catch (error: any) {
			return { ok: false, message: error?.message || 'Setup failed' };
		}
	}

	async runContextPack(topic: string, budget = 8000): Promise<string> {
		const cliPath = this.resolveCliPath();
		if (!cliPath) return '';

		const vaultPath = this.getWikiVaultPath();
		if (!vaultPath) return '';

		try {
			const output = await this.exec(
				cliPath,
				['context-pack', '--budget', String(budget), '--json', topic],
				15000,
				{ OBSIDIAN_VAULT_PATH: vaultPath },
			);
			return output.stdout.trim();
		} catch {
			return '';
		}
	}

	async listSkills(): Promise<string[]> {
		const cliPath = this.resolveCliPath();
		if (!cliPath) return [];

		try {
			const output = await this.exec(cliPath, ['list'], 10000);
			return output.stdout
				.split('\n')
				.map(l => l.trim())
				.filter(l => l && !l.startsWith('#') && !l.startsWith('-'));
		} catch {
			return [];
		}
	}

	getWikiVaultPath(): string {
		if (this.plugin.settings.wikiVaultPath) {
			return this.plugin.settings.wikiVaultPath;
		}
		return this.plugin.getVaultPath();
	}

	private async exec(
		command: string,
		args: string[],
		timeout = 30000,
		extraEnv?: Record<string, string>,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			const env = { ...process.env, ...extraEnv };
			const child = spawn(command, args, {
				env,
				cwd: this.getWikiVaultPath() || undefined,
				timeout,
				windowsHide: true,
			});

			this.activeChild = child;
			let stdout = '';
			let stderr = '';

			child.stdout.on('data', (data: Buffer) => {
				stdout += data.toString();
			});

			child.stderr.on('data', (data: Buffer) => {
				stderr += data.toString();
			});

			child.on('close', (code) => {
				this.activeChild = null;
				resolve({ stdout, stderr, exitCode: code ?? 1 });
			});

			child.on('error', (err) => {
				this.activeChild = null;
				reject(err);
			});
		});
	}
}
