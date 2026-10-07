/**
 * The one way a guard builds a TypeScript program over the worker's source
 * (see _worker-program.test.ts, which also refuses a second copy).
 *
 * The worker's tsconfig is handed to TypeScript WITH its path. Without it,
 * `types: ["@cloudflare/workers-types"]` resolves from the current directory
 * (apps/web), where the package is not installed, and every Request, URL and
 * Response in the program becomes `any`: a guard keyed on one of those types
 * then matches nothing and passes. Check workerProgramLoadErrors is empty
 * before trusting a clean result.
 */
import path from 'node:path'
import ts from 'typescript'
import { WORKER_SRC } from './_scan-utils'

const WORKER_ROOT = path.dirname(WORKER_SRC)
const CONFIG_PATH = path.join(WORKER_ROOT, 'tsconfig.json')

function workerCompilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(CONFIG_PATH, (p) => ts.sys.readFile(p))
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  return ts.parseJsonConfigFileContent(config.config, ts.sys, WORKER_ROOT, undefined, CONFIG_PATH).options
}

/** A program over the given worker files, with `extra` served from memory on top of the disk. */
export function buildWorkerProgram(roots: string[], extra: Record<string, string> = {}): ts.Program {
  const options = workerCompilerOptions()
  const host = ts.createCompilerHost(options, true)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (f) => extra[f] ?? readFile(f)
  host.fileExists = (f) => f in extra || fileExists(f)
  host.getSourceFile = (f, lang, onError, create) =>
    f in extra ? ts.createSourceFile(f, extra[f], lang, true) : getSourceFile(f, lang, onError, create)
  return ts.createProgram({ rootNames: [...roots, ...Object.keys(extra)], options, host })
}

/** What stopped the program loading fully (a missing types package among them); empty when it loaded. */
export function workerProgramLoadErrors(program: ts.Program): string[] {
  return [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}
