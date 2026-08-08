import { Notice, TFile, TFolder, Platform } from 'obsidian';
import GeminiSyncPlugin from './main';

type ChildProcessWithoutNullStreams = import('child_process').ChildProcessWithoutNullStreams;

function requireDesktop() {
	if (!Platform.isDesktopApp) throw new Error('This feature requires Obsidian desktop.');
	return {
		spawn: require('child_process').spawn as typeof import('child_process').spawn,
		existsSync: require('fs').existsSync as typeof import('fs').existsSync,
		homedir: require('os').homedir as typeof import('os').homedir,
		delimiter: require('path').delimiter as string,
		join: require('path').join as typeof import('path').join,
	};
}

export interface WikiStatusResult {
	installed: boolean;
	vaultConfigured: boolean;
	vaultPath: string;
	cliPath: string;
	pageCount: number;
	categories: string[];
	hasManifest: boolean;
	hasIndex: boolean;
	hasLog: boolean;
	hasHot: boolean;
	hasTrustLedger: boolean;
	stagingCount: number;
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

export interface WikiCliResult {
	ok: boolean;
	output: string;
	error?: string;
}

export interface WikiStagedFile {
	path: string;
	name: string;
	content: string;
}

export interface WikiTrustEntry {
	page: string;
	status: string;
	confidence: number;
	reviewer: string;
	timestamp: string;
}

export interface WikiManifestEntry {
	path: string;
	hash: string;
}

export interface WikiSessionCluster {
	id: number;
	label: string;
	sessions: string[];
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
		const { existsSync, homedir, delimiter, join } = requireDesktop();
		const configured = this.plugin.settings.wikiCliPath?.trim();
		if (configured && configured !== 'obsidian-wiki') {
			if (existsSync(configured)) return configured;
		}

		const candidates = [
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

	getWikiVaultPath(): string {
		if (this.plugin.settings.wikiVaultPath) {
			return this.plugin.settings.wikiVaultPath;
		}
		return this.plugin.getVaultPath();
	}

	private getEnv(): Record<string, string> {
		const env: Record<string, string> = { OBSIDIAN_VAULT_PATH: this.getWikiVaultPath() };
		if (this.plugin.settings.wikiStagedWrites) {
			env.WIKI_STAGED_WRITES = '1';
		}
		return env;
	}

	private requireCli(): string {
		const cliPath = this.resolveCliPath();
		if (!cliPath) throw new Error('obsidian-wiki CLI not found. Install with: pip install obsidian-wiki');
		return cliPath;
	}

	// ── Status & Setup ──────────────────────────────────────────────────

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
			hasLog: false,
			hasHot: false,
			hasTrustLedger: false,
			stagingCount: 0,
		};

		if (!cliPath) {
			result.error = 'obsidian-wiki CLI not found. Install with: pip install obsidian-wiki';
			return result;
		}

		result.installed = true;

		try {
			await this.exec(cliPath, ['doctor'], 10000);
		} catch {
			result.error = 'obsidian-wiki doctor check failed';
		}

		if (vaultPath) {
			const vault = this.plugin.app.vault;
			result.hasManifest = !!vault.getAbstractFileByPath('.manifest.json');
			result.hasIndex = !!vault.getAbstractFileByPath('index.md');
			result.hasLog = !!vault.getAbstractFileByPath('log.md');
			result.hasHot = !!vault.getAbstractFileByPath('hot.md');
			result.hasTrustLedger = !!vault.getAbstractFileByPath('_meta/trust-ledger.json');

			const staging = vault.getAbstractFileByPath('_staging');
			if (staging && staging instanceof TFolder) {
				result.stagingCount = staging.children.filter(f => f instanceof TFile && (f as TFile).extension === 'md').length;
			}

			const categories = ['concepts', 'entities', 'skills', 'references', 'synthesis', 'journal', 'projects'];
			result.categories = categories.filter(c => !!vault.getAbstractFileByPath(c));

			let count = 0;
			for (const cat of result.categories) {
				const folder = vault.getAbstractFileByPath(cat);
				if (folder && folder instanceof TFolder) {
					count += this.countMarkdownFiles(folder);
				}
			}
			result.pageCount = count;
		}

		return result;
	}

	private countMarkdownFiles(folder: TFolder): number {
		let count = 0;
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') count++;
			if (child instanceof TFolder) count += this.countMarkdownFiles(child);
		}
		return count;
	}

	async runSetup(): Promise<WikiCliResult> {
		const cli = this.requireCli();
		const vaultPath = this.getWikiVaultPath();
		if (!vaultPath) return { ok: false, output: '', error: 'Wiki vault path not configured.' };

		try {
			const out = await this.exec(cli, ['setup', '--vault', vaultPath], 30000);
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	// ── Query ────────────────────────────────────────────────────────────

	async runQuery(query: string): Promise<WikiQueryResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, ['query', query], 30000, this.getEnv());
			const sources: string[] = [];
			for (const line of out.stdout.split('\n')) {
				const matches = line.match(/\[\[([^\]]+)\]\]/g);
				if (matches) sources.push(...matches.map(m => m.replace(/^\[\[|\]\]$/g, '')));
			}
			return { answer: out.stdout.trim(), sources: [...new Set(sources)], error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { answer: '', sources: [], error: e?.message || 'Query failed' };
		}
	}

	async runGraphQuery(query: string): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, ['graph-query', query], 20000, this.getEnv());
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	async runContextPack(topic: string, budget = 8000): Promise<string> {
		const cli = this.resolveCliPath();
		if (!cli) return '';
		try {
			const out = await this.exec(cli, ['context-pack', '--budget', String(budget), '--json', topic], 15000, this.getEnv());
			return out.stdout.trim();
		} catch {
			return '';
		}
	}

	// ── Lint & Maintenance ──────────────────────────────────────────────

	async runLint(): Promise<WikiLintResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, ['lint'], 30000, this.getEnv());
			const checks = this.parseLintOutput(out.stdout);
			const failCount = checks.filter(c => c.status === 'fail').length;
			const warnCount = checks.filter(c => c.status === 'warn').length;
			const passCount = checks.filter(c => c.status === 'pass').length;
			return {
				ok: failCount === 0,
				checks,
				summary: `${passCount} passed, ${warnCount} warnings, ${failCount} failed`,
				error: out.exitCode !== 0 ? out.stderr.trim() : undefined,
			};
		} catch (e: any) {
			return { ok: false, checks: [], summary: '', error: e?.message };
		}
	}

	private parseLintOutput(stdout: string): WikiLintCheck[] {
		const checks: WikiLintCheck[] = [];
		let current: WikiLintCheck | null = null;
		for (const line of stdout.split('\n')) {
			const pass = line.match(/^\s*(PASS|OK|✓)\s+(.+)/i);
			const fail = line.match(/^\s*(FAIL|ERROR|✗|✘)\s+(.+)/i);
			const warn = line.match(/^\s*(WARN|WARNING|⚠)\s+(.+)/i);
			if (pass) { current = { name: pass[2].trim(), status: 'pass', message: pass[2].trim() }; checks.push(current); }
			else if (fail) { current = { name: fail[2].trim(), status: 'fail', message: fail[2].trim(), items: [] }; checks.push(current); }
			else if (warn) { current = { name: warn[2].trim(), status: 'warn', message: warn[2].trim(), items: [] }; checks.push(current); }
			else if (current?.items && line.trim().startsWith('-')) { current.items.push(line.trim().slice(1).trim()); }
		}
		return checks;
	}

	async runCrossLinker(): Promise<WikiCliResult> {
		return this.runCliCommand(['cross-link'], 60000);
	}

	async runDedup(): Promise<WikiCliResult> {
		return this.runCliCommand(['dedup'], 60000);
	}

	async runRebuild(): Promise<WikiCliResult> {
		return this.runCliCommand(['rebuild'], 120000);
	}

	async runSync(): Promise<WikiCliResult> {
		return this.runCliCommand(['sync'], 30000);
	}

	// ── Ingest ──────────────────────────────────────────────────────────

	async runCacheCheck(sourcePath: string): Promise<WikiCliResult> {
		return this.runCliCommand(['cache-check', sourcePath], 15000);
	}

	async runCacheUpdate(sourcePath: string): Promise<WikiCliResult> {
		return this.runCliCommand(['cache-update', sourcePath], 15000);
	}

	// ── Sessions ────────────────────────────────────────────────────────

	async runSessionsBuild(): Promise<WikiCliResult> {
		return this.runCliCommand(['sessions-build'], 60000);
	}

	async runSessionsQuery(query: string): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, ['sessions-query', query], 30000, this.getEnv());
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	async runSessionsClusters(): Promise<WikiCliResult> {
		return this.runCliCommand(['sessions-clusters'], 30000);
	}

	// ── Trust ───────────────────────────────────────────────────────────

	async runTrustCheck(page: string): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, ['trust-check', page], 10000, this.getEnv());
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	async runTrustRecord(page: string): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, ['trust-record', page], 10000, this.getEnv());
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	async readTrustLedger(): Promise<WikiTrustEntry[]> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath('_meta/trust-ledger.json');
			if (!(file instanceof TFile)) return [];
			const text = await this.plugin.app.vault.read(file);
			const data = JSON.parse(text);
			if (Array.isArray(data)) return data;
			if (data && typeof data === 'object') {
				return Object.entries(data).map(([page, entry]: [string, any]) => ({
					page,
					status: entry.status || entry.verdict || 'unknown',
					confidence: entry.confidence ?? entry.score ?? 0,
					reviewer: entry.reviewer || entry.by || '',
					timestamp: entry.timestamp || entry.date || '',
				}));
			}
			return [];
		} catch {
			return [];
		}
	}

	// ── Staging ─────────────────────────────────────────────────────────

	async listStagedFiles(): Promise<WikiStagedFile[]> {
		const staging = this.plugin.app.vault.getAbstractFileByPath('_staging');
		if (!staging || !(staging instanceof TFolder)) return [];

		const files: WikiStagedFile[] = [];
		for (const child of staging.children) {
			if (child instanceof TFile && child.extension === 'md') {
				try {
					const content = await this.plugin.app.vault.read(child);
					files.push({ path: child.path, name: child.basename, content });
				} catch {
					files.push({ path: child.path, name: child.basename, content: '' });
				}
			}
		}
		return files;
	}

	async approveStagedFile(stagedPath: string): Promise<WikiCliResult> {
		const file = this.plugin.app.vault.getAbstractFileByPath(stagedPath);
		if (!(file instanceof TFile)) return { ok: false, output: '', error: `File not found: ${stagedPath}` };

		try {
			const content = await this.plugin.app.vault.read(file);
			const targetName = file.basename;
			let targetPath = '';

			const categoryMatch = content.match(/^category:\s*(.+)/m);
			const category = categoryMatch ? categoryMatch[1].trim() : 'concepts';
			targetPath = `${category}/${targetName}.md`;

			const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
			if (existing instanceof TFile) {
				await this.plugin.app.vault.modify(existing, content);
			} else {
				const folder = targetPath.split('/').slice(0, -1).join('/');
				if (folder) await this.plugin.ensureVaultFolder(folder);
				await this.plugin.app.vault.create(targetPath, content);
			}

			await this.plugin.app.vault.delete(file);
			return { ok: true, output: `Approved: ${stagedPath} → ${targetPath}` };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	async rejectStagedFile(stagedPath: string): Promise<WikiCliResult> {
		const file = this.plugin.app.vault.getAbstractFileByPath(stagedPath);
		if (!(file instanceof TFile)) return { ok: false, output: '', error: `File not found: ${stagedPath}` };
		try {
			await this.plugin.app.vault.delete(file);
			return { ok: true, output: `Rejected and deleted: ${stagedPath}` };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	// ── Manifest ────────────────────────────────────────────────────────

	async readManifest(): Promise<WikiManifestEntry[]> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath('.manifest.json');
			if (!(file instanceof TFile)) return [];
			const text = await this.plugin.app.vault.read(file);
			const data = JSON.parse(text);
			if (data && typeof data === 'object' && !Array.isArray(data)) {
				return Object.entries(data)
					.filter(([key]) => key !== 'last_commit_synced')
					.map(([path, hash]) => ({ path, hash: String(hash) }));
			}
			return [];
		} catch {
			return [];
		}
	}

	// ── Export ───────────────────────────────────────────────────────────

	async runExport(format: 'json' | 'graphml' | 'cypher' | 'html'): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const args = ['graph-analyse', '--format', format];
			const out = await this.exec(cli, args, 30000, this.getEnv());
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	// ── AST Extract ─────────────────────────────────────────────────────

	async runAstExtract(filePath: string): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, ['ast-extract', filePath], 15000, this.getEnv());
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	// ── Skills ──────────────────────────────────────────────────────────

	async listSkills(): Promise<string[]> {
		const cli = this.resolveCliPath();
		if (!cli) return [];
		try {
			const out = await this.exec(cli, ['list'], 10000);
			return out.stdout.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('-'));
		} catch {
			return [];
		}
	}

	async getSkillInfo(skillName: string): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, ['info', skillName], 10000);
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	// ── Read vault special files ────────────────────────────────────────

	async readSpecialFile(name: 'index.md' | 'log.md' | 'hot.md' | '_insights.md'): Promise<string> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(name);
			if (file instanceof TFile) return await this.plugin.app.vault.read(file);
		} catch { /* ignore */ }
		return '';
	}

	// ── Generic CLI runner ──────────────────────────────────────────────

	private async runCliCommand(args: string[], timeout = 30000): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, args, timeout, this.getEnv());
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	async runArbitrary(args: string[], timeout = 30000, onChunk?: (chunk: string) => void): Promise<WikiCliResult> {
		const cli = this.requireCli();
		try {
			const out = await this.exec(cli, args, timeout, this.getEnv(), onChunk);
			return { ok: out.exitCode === 0, output: out.stdout.trim(), error: out.exitCode !== 0 ? out.stderr.trim() : undefined };
		} catch (e: any) {
			return { ok: false, output: '', error: e?.message };
		}
	}

	// ── Process execution ───────────────────────────────────────────────

	private async exec(
		command: string,
		args: string[],
		timeout = 30000,
		extraEnv?: Record<string, string>,
		onChunk?: (chunk: string) => void,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const { spawn } = requireDesktop();
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
				const chunk = data.toString();
				stdout += chunk;
				if (onChunk) onChunk(chunk);
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
