import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface SidecarTarget {
	readonly bunTarget: string
	readonly triple: string
	readonly extension: string
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const target = resolveTarget()
const output = join(
	repoRoot,
	'apps',
	'desktop',
	'src-tauri',
	'binaries',
	`qcp-assistant-${target.triple}${target.extension}`,
)
const args = [
	'build',
	'./src/desktop/assistant-runner.ts',
	'--compile',
	'--outfile',
	output,
]

if (!isCurrentHostTarget(target)) {
	args.splice(3, 0, `--target=${target.bunTarget}`)
}

mkdirSync(dirname(output), { recursive: true })

const result = spawnSync('bun', args, {
	cwd: repoRoot,
	stdio: 'inherit',
})

if (result.error) {
	throw result.error
}

process.exitCode = result.status ?? 1

function resolveTarget(): SidecarTarget {
	const platform = normalizePlatform(
		process.env.TAURI_ENV_PLATFORM ?? process.platform,
	)
	const arch = normalizeArch(process.env.TAURI_ENV_ARCH ?? process.arch)

	if (platform === 'macos' && arch === 'arm64') {
		return {
			bunTarget: 'bun-macos-arm64',
			triple: 'aarch64-apple-darwin',
			extension: '',
		}
	}

	if (platform === 'macos' && arch === 'x64') {
		return {
			bunTarget: 'bun-macos-x64',
			triple: 'x86_64-apple-darwin',
			extension: '',
		}
	}

	if (platform === 'linux' && arch === 'x64') {
		return {
			bunTarget: 'bun-linux-x64',
			triple: 'x86_64-unknown-linux-gnu',
			extension: '',
		}
	}

	if (platform === 'linux' && arch === 'arm64') {
		return {
			bunTarget: 'bun-linux-arm64',
			triple: 'aarch64-unknown-linux-gnu',
			extension: '',
		}
	}

	if (platform === 'windows' && arch === 'x64') {
		return {
			bunTarget: 'bun-windows-x64',
			triple: 'x86_64-pc-windows-msvc',
			extension: '.exe',
		}
	}

	throw new Error(`Unsupported desktop sidecar target: ${platform}/${arch}`)
}

function isCurrentHostTarget(target: SidecarTarget): boolean {
	const host = resolveHostTarget()
	return host.triple === target.triple
}

function resolveHostTarget(): SidecarTarget {
	return resolveTargetFromHost(process.platform, process.arch)
}

function resolveTargetFromHost(platform: NodeJS.Platform, arch: string): SidecarTarget {
	return resolveTargetFromParts(normalizePlatform(platform), normalizeArch(arch))
}

function resolveTargetFromParts(platform: string, arch: string): SidecarTarget {
	const originalPlatform = process.env.TAURI_ENV_PLATFORM
	const originalArch = process.env.TAURI_ENV_ARCH

	process.env.TAURI_ENV_PLATFORM = platform
	process.env.TAURI_ENV_ARCH = arch

	try {
		return resolveTarget()
	} finally {
		if (originalPlatform === undefined) {
			delete process.env.TAURI_ENV_PLATFORM
		} else {
			process.env.TAURI_ENV_PLATFORM = originalPlatform
		}

		if (originalArch === undefined) {
			delete process.env.TAURI_ENV_ARCH
		} else {
			process.env.TAURI_ENV_ARCH = originalArch
		}
	}
}

function normalizePlatform(platform: string): string {
	if (platform === 'darwin') return 'macos'
	if (platform === 'win32') return 'windows'
	return platform
}

function normalizeArch(arch: string): string {
	if (arch === 'aarch64') return 'arm64'
	if (arch === 'x86_64') return 'x64'
	return arch
}
