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
import { WORKER_SRC } from '../../__tests__/_scan-utils'

const WORKER_ROOT = path.dirname(WORKER_SRC)
const CONFIG_PATH = path.join(WORKER_ROOT, 'tsconfig.json')

function workerCompilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(CONFIG_PATH, (p) => ts.sys.readFile(p))
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  return ts.parseJsonConfigFileContent(config.config, ts.sys, WORKER_ROOT, undefined, CONFIG_PATH).options
}

/**
 * Each file read from disk, parsed once per test file and shared by every
 * program built after it (#2619). A guard building a program per planted case
 * otherwise parsed the TypeScript and Workers type libraries and the worker
 * source again for each one, inside the test's 5 second limit. Sharing parsed
 * files between programs built with the same options is what TypeScript's own
 * language service does; a file served from `extra` is never kept.
 */
const diskFiles = new Map<string, ts.SourceFile>()
const versionKey = (lang: ts.ScriptTarget | ts.CreateSourceFileOptions): string =>
  typeof lang === 'object' ? `${lang.languageVersion}:${lang.impliedNodeFormat ?? ''}` : String(lang)

/** A program over the given worker files, with `extra` served from memory on top of the disk. */
export function buildWorkerProgram(roots: string[], extra: Record<string, string> = {}): ts.Program {
  const options = workerCompilerOptions()
  const host = ts.createCompilerHost(options, true)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (f) => extra[f] ?? readFile(f)
  host.fileExists = (f) => f in extra || fileExists(f)
  host.getSourceFile = (f, lang, onError, create) => {
    if (f in extra) return ts.createSourceFile(f, extra[f], lang, true)
    const key = `${f}\0${versionKey(lang)}`
    let file = diskFiles.get(key)
    if (file === undefined) {
      file = getSourceFile(f, lang, onError, create)
      if (file !== undefined) diskFiles.set(key, file)
    }
    return file
  }
  return ts.createProgram({ rootNames: [...roots, ...Object.keys(extra)], options, host })
}

/** What stopped the program loading fully (a missing types package among them); empty when it loaded. */
export function workerProgramLoadErrors(program: ts.Program): string[] {
  return [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}
