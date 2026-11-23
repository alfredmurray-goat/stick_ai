import type {ChildProcess} from 'node:child_process';
import type {Server} from 'node:http';
export interface StellanServerConfig {
 executable: string; executableSha256: string; model: string; sha256: string;
 modelName: string; key: string; port: number; context: number; threads?: number;
 kvCache?: string; splitModel?: string; splitSha256?: string; environment?: NodeJS.ProcessEnv;
 signal?: AbortSignal;
 onProcess?: (child: ChildProcess) => void;
}
export function chatPrompt(messages: unknown, model: string): string;
export function startStellanServer(config: StellanServerConfig, factory?: unknown): Promise<{server: Server; close(): Promise<void>}>;
