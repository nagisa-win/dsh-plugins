import { AsyncLocalStorage } from "node:async_hooks"
import { execFile } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"

export const name = "ducc-attribution"

const execFileAsync = promisify(execFile)
const DEFAULT_AUTH_BASE = ""
const DEFAULT_DATA_BASE = ""
const DEFAULT_CLIENT_TOKEN = ""
const HEADER_NAME = "comate_custom_header"
const DEFAULT_PROVIDER_IDS = ["one-api", "one-api-openai"]
const DEFAULT_ENDPOINT_PREFIXES = []
const MUTATING_FILE_TOOLS = new Set(["write", "edit"])
const MUTATING_EDITOR_COMMANDS = new Set(["create", "str_replace", "insert"])
const MAX_GIT_CACHE_ENTRIES = 64

function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`ducc-attribution: ${name} must be a positive safe integer`)
  }
  return resolved
}

function stringList(value, fallback, name) {
  const resolved = value ?? fallback
  if (!Array.isArray(resolved) || resolved.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`ducc-attribution: ${name} must contain non-empty strings`)
  }
  return resolved
}

function readTokenFile(path) {
  try {
    const value = readFileSync(path, "utf8").trim()
    return value || undefined
  } catch {
    return undefined
  }
}

function latestLoginFile(home) {
  const directory = join(home, ".comate", "login-user")
  let best
  try {
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(".")) continue
      const path = join(directory, entry)
      try {
        const stat = statSync(path)
        if (!stat.isFile()) continue
        const token = readTokenFile(path)
        if (!token) continue
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { path, name: entry, mtimeMs: stat.mtimeMs, token }
        }
      } catch {}
    }
  } catch {}
  return best
}

function createIdentityResolver(config) {
  let cachedJwt

  function discover() {
    const home = config.home ?? homedir()
    const latest = latestLoginFile(home)
    if (latest) {
      if (!cachedJwt || cachedJwt.path !== latest.path || cachedJwt.mtimeMs !== latest.mtimeMs) {
        cachedJwt = latest
      }
      return { jwt: cachedJwt.token, username: config.username ?? latest.name }
    }

    const path = join(home, ".comate", "login")
    let mtimeMs = 0
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {}
    if (!cachedJwt || cachedJwt.path !== path || cachedJwt.mtimeMs !== mtimeMs) {
      cachedJwt = { path, mtimeMs, token: readTokenFile(path) }
    }
    return {
      jwt: cachedJwt.token,
      username: config.username
        ?? process.env.DUCC_USERNAME
        ?? process.env.BAIDU_CC_USERNAME
        ?? process.env.USER,
    }
  }

  return { discover }
}

function repoName(remoteUrl, cwd) {
  if (!remoteUrl) return basename(cwd)
  const normalized = remoteUrl.replace(/[\\/]+$/, "")
  const last = normalized.slice(normalized.lastIndexOf("/") + 1)
  const scpLike = last.includes(":") ? last.slice(last.lastIndexOf(":") + 1) : last
  return scpLike.replace(/\.git$/, "") || basename(cwd)
}

function createGitResolver(ttlMs) {
  const cache = new Map()
  const inflight = new Map()

  async function command(cwd, args) {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return result.stdout.trim()
  }

  async function load(cwd) {
    try {
      const [branch, commitId, remoteUrl] = await Promise.all([
        command(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
        command(cwd, ["rev-parse", "HEAD"]),
        command(cwd, ["config", "--get", "remote.origin.url"]).catch(() => ""),
      ])
      return {
        repo: repoName(remoteUrl, cwd),
        branch: branch === "HEAD" ? "" : branch,
        commitId: commitId.slice(0, 8),
      }
    } catch {
      return { repo: basename(cwd), branch: "", commitId: "" }
    }
  }

  async function resolve(cwd) {
    const existing = cache.get(cwd)
    if (existing && Date.now() < existing.expiresAt) return existing.value
    const pending = inflight.get(cwd)
    if (pending) return pending

    const next = load(cwd).then((value) => {
      if (!cache.has(cwd) && cache.size >= MAX_GIT_CACHE_ENTRIES) {
        cache.delete(cache.keys().next().value)
      }
      cache.set(cwd, { value, expiresAt: Date.now() + ttlMs })
      return value
    }).finally(() => inflight.delete(cwd))
    inflight.set(cwd, next)
    return next
  }

  return { resolve }
}

function requestUrl(input) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input instanceof Request ? input.url : undefined
}

function mergeHeaders(input, init, additions) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
  }
  for (const [key, value] of Object.entries(additions)) headers.set(key, value)
  return headers
}

function normalizeJsonSchema(schema, seen = new Set()) {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return false
  seen.add(schema)
  let changed = false
  if ((schema.type === "object" || schema.properties) && !Array.isArray(schema.required)) {
    schema.required = []
    changed = true
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const property of Object.values(schema.properties)) {
      changed = normalizeJsonSchema(property, seen) || changed
    }
  }
  if (schema.items) changed = normalizeJsonSchema(schema.items, seen) || changed
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (!Array.isArray(schema[keyword])) continue
    for (const child of schema[keyword]) changed = normalizeJsonSchema(child, seen) || changed
  }
  for (const keyword of ["$defs", "definitions", "dependentSchemas", "patternProperties"]) {
    const children = schema[keyword]
    if (!children || typeof children !== "object") continue
    for (const child of Object.values(children)) changed = normalizeJsonSchema(child, seen) || changed
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    changed = normalizeJsonSchema(schema.additionalProperties, seen) || changed
  }
  return changed
}

function normalizeToolSchemas(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) return false
  let changed = false
  for (const tool of payload.tools) {
    if (!tool || typeof tool !== "object") continue
    for (const schema of [tool.parameters, tool.input_schema, tool.function?.parameters]) {
      changed = normalizeJsonSchema(schema) || changed
    }
  }
  return changed
}

function normalizeRequestBody(init) {
  if (typeof init?.body !== "string") return init
  const contentType = new Headers(init.headers).get("content-type")
  if (contentType && !contentType.toLowerCase().includes("json")) return init
  try {
    const payload = JSON.parse(init.body)
    if (!normalizeToolSchemas(payload)) return init
    return { ...init, body: JSON.stringify(payload) }
  } catch {
    return init
  }
}

function runIteratorInContext(storage, context, iterable) {
  const iterator = iterable[Symbol.asyncIterator]()
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next(value) {
      return storage.run(context, () => iterator.next(value))
    },
    return(value) {
      if (!iterator.return) return Promise.resolve({ done: true, value })
      return storage.run(context, () => iterator.return(value))
    },
    throw(error) {
      if (!iterator.throw) return Promise.reject(error)
      return storage.run(context, () => iterator.throw(error))
    },
  }
}

function mutationPath(exec, result) {
  if (result.isError) return undefined
  const input = exec.arguments
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const path = typeof input.path === "string" ? input.path : undefined
  if (!path) return undefined
  if (MUTATING_FILE_TOOLS.has(exec.name)) return path
  if (exec.name !== "str_replace_editor") return undefined
  return MUTATING_EDITOR_COMMANDS.has(input.command) ? path : undefined
}

export function apply(ctx, rawConfig = {}) {
  const config = {
    providerIds: stringList(rawConfig.providerIds, DEFAULT_PROVIDER_IDS, "providerIds"),
    endpointPrefixes: stringList(
      rawConfig.endpointPrefixes,
      DEFAULT_ENDPOINT_PREFIXES,
      "endpointPrefixes",
    ),
    authBase: rawConfig.authBase ?? process.env.DUCC_AUTH_BASE ?? DEFAULT_AUTH_BASE,
    dataBase: rawConfig.dataBase ?? process.env.DUCC_DATA_BASE ?? DEFAULT_DATA_BASE,
    clientToken: rawConfig.clientToken ?? process.env.DUCC_CLIENT_TOKEN ?? DEFAULT_CLIENT_TOKEN,
    platform: rawConfig.platform ?? process.env.BAIDU_CC_PLATFORM ?? "deepseek-harness",
    source: rawConfig.source ?? "ducc",
    username: rawConfig.username,
    home: rawConfig.home,
    reportEvents: rawConfig.reportEvents !== false,
    requestTimeoutMs: positiveInteger(rawConfig.requestTimeoutMs, 5_000, "requestTimeoutMs"),
    sessionAuthTtlMs: positiveInteger(rawConfig.sessionAuthTtlMs, 4 * 60_000, "sessionAuthTtlMs"),
    gitCacheTtlMs: positiveInteger(rawConfig.gitCacheTtlMs, 30_000, "gitCacheTtlMs"),
    reportQueueSize: positiveInteger(rawConfig.reportQueueSize, 256, "reportQueueSize"),
  }
  if (!config.authBase || !config.dataBase || !config.clientToken || !config.platform || !config.source) {
    throw new Error("ducc-attribution: URL, client token, platform, and source values must be non-empty")
  }

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== "function") {
    ctx.logger.warn("ducc-attribution: no global fetch to wrap")
    return
  }

  const requestContext = new AsyncLocalStorage()
  const identity = createIdentityResolver(config)
  const git = createGitResolver(config.gitCacheTtlMs)
  const providerIds = new Set(config.providerIds)
  const sessionCwds = new Map()
  const sessionProviders = new Map()
  const runningSessions = new Set()
  const reports = []
  const pendingReports = new Set()
  const lifecycle = new AbortController()
  let reportWorker
  let sessionAuth
  let sessionAuthExpireAt = 0
  let sessionAuthInflight

  function matchesEndpoint(url) {
    return config.endpointPrefixes.some((prefix) => url.startsWith(prefix))
  }

  function isTargetProvider(provider) {
    return typeof provider === "string" && providerIds.has(provider)
  }

  function timeoutSignal() {
    return AbortSignal.any([
      lifecycle.signal,
      AbortSignal.timeout(config.requestTimeoutMs),
    ])
  }

  async function refreshSessionAuth() {
    if (sessionAuth && Date.now() < sessionAuthExpireAt) return sessionAuth
    if (sessionAuthInflight) return sessionAuthInflight
    const discovered = identity.discover()
    if (!discovered.jwt || !discovered.username) return undefined

    sessionAuthInflight = (async () => {
      try {
        const url = new URL("/api/rest/v1/jwt/model", config.authBase)
        url.searchParams.set("accessToken", discovered.jwt)
        url.searchParams.set("agent", "ducc")
        url.searchParams.set("authTokenType", "jwt_token")
        url.searchParams.set("version", "2.1.201.9")
        const jwtResponse = await originalFetch(url, {
          headers: {
            "content-type": "application/json",
            "x-auth-client-token": config.clientToken,
          },
          signal: timeoutSignal(),
        })
        if (!jwtResponse.ok) return undefined
        const jwtData = await jwtResponse.json()
        if (!jwtData?.modelToken) return undefined

        const authResponse = await originalFetch(
          new URL("/api/rest/v1/source-auth/ducc/generate", config.authBase),
          {
            method: "POST",
            headers: {
              "x-api-key": jwtData.modelToken,
              "x-auth-client-token": config.clientToken,
            },
            signal: timeoutSignal(),
          },
        )
        if (!authResponse.ok) return undefined
        const authData = await authResponse.json()
        if (!authData?.data) return undefined
        sessionAuth = {
          username: jwtData.userName ?? discovered.username,
          signature: authData.data.signature,
          timestamp: authData.data.timestamp,
          version: authData.data.version,
        }
        sessionAuthExpireAt = Date.now() + config.sessionAuthTtlMs
        return sessionAuth
      } catch {
        return undefined
      } finally {
        sessionAuthInflight = undefined
      }
    })()
    return sessionAuthInflight
  }

  async function buildHeader(cwd) {
    const auth = await refreshSessionAuth()
    const username = auth?.username ?? identity.discover().username
    if (!username) return undefined
    const info = await git.resolve(cwd)
    const payload = {
      agentId: `ducc:user:${username}`,
      username,
      repo: info.repo,
      source: config.source,
      commitId: info.commitId,
      branch: info.branch,
      os: process.platform,
    }
    if (auth) {
      payload["x-source-auth-version"] = auth.version
      payload["x-source-auth-timestamp"] = auth.timestamp
      payload["x-source-auth-signature"] = auth.signature
    }
    return JSON.stringify(payload)
  }

  async function wrappedFetch(input, init) {
    const active = requestContext.getStore()
    const url = requestUrl(input)
    if (!active || !url || !isTargetProvider(active.provider) || !matchesEndpoint(url)) {
      return originalFetch(input, init)
    }
    const cwd = active.cwd ?? process.cwd()
    const header = await buildHeader(cwd)
    const normalizedInit = normalizeRequestBody(init)
    if (!header) return originalFetch(input, normalizedInit)
    return originalFetch(input, {
      ...normalizedInit,
      headers: mergeHeaders(input, normalizedInit, { [HEADER_NAME]: header }),
    })
  }

  async function sendReport(entry) {
    const username = sessionAuth?.username ?? identity.discover().username
    if (!username) return
    try {
      await originalFetch(new URL("/api/rest/v1/upload/query", config.dataBase), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-client-token": config.clientToken,
        },
        body: JSON.stringify({
          ...entry,
          username,
          platform: config.platform,
          timestamp: new Date().toISOString(),
        }),
        signal: timeoutSignal(),
      })
    } catch {}
  }

  function pumpReports() {
    if (reportWorker || reports.length === 0 || lifecycle.signal.aborted) return
    const worker = (async () => {
      while (reports.length > 0 && !lifecycle.signal.aborted) {
        await sendReport(reports.shift())
      }
    })().finally(() => {
      reportWorker = undefined
      if (reports.length > 0) pumpReports()
    })
    reportWorker = worker
    pendingReports.add(worker)
    worker.finally(() => pendingReports.delete(worker))
  }

  function report(entry) {
    if (!config.reportEvents || lifecycle.signal.aborted) return
    if (reports.length >= config.reportQueueSize) {
      ctx.logger.warn("ducc-attribution: report queue full; dropping event")
      return
    }
    reports.push(entry)
    pumpReports()
  }

  globalThis.fetch = wrappedFetch
  void refreshSessionAuth()

  ctx.on("llm/stream", (options, next) => {
    if (!isTargetProvider(options.provider)) return next()
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    if (sessionId) sessionProviders.set(sessionId, options.provider)
    const context = {
      provider: options.provider,
      model: options.model,
      sessionId,
      cwd: sessionId ? sessionCwds.get(sessionId) : undefined,
    }
    return runIteratorInContext(requestContext, context, next())
  })

  ctx.on("agent/created", ({ agent, source }) => {
    const sessionId = String(agent.session.id)
    const cwd = agent.session.header.cwd
    if (cwd) sessionCwds.set(sessionId, cwd)
    const provider = agent.options.provider
    if (provider) sessionProviders.set(sessionId, provider)
    if (!isTargetProvider(provider)) return
    report({
      hook_event_name: "session_start",
      session_id: sessionId,
      cwd,
      source,
    })
  })

  ctx.on("session/event", (session, event) => {
    const sessionId = String(session.id)
    if (!isTargetProvider(sessionProviders.get(sessionId))) return
    if (event.type === "user/message" && event.data.source.kind === "user") {
      report({
        hook_event_name: "user_prompt_submit",
        session_id: sessionId,
        message_id: String(event.data.id),
      })
    }
  })

  ctx.on("agent/status", ({ agent, status }) => {
    const sessionId = String(agent.session.id)
    if (!isTargetProvider(sessionProviders.get(sessionId) ?? agent.options.provider)) return
    if (status === "running") {
      runningSessions.add(sessionId)
      return
    }
    if (!runningSessions.delete(sessionId)) return
    report({ hook_event_name: "stop", session_id: sessionId })
  })

  ctx.on("tools/result", (exec, result) => {
    const sessionId = exec.agent ? String(exec.agent.session.id) : undefined
    if (!sessionId || !isTargetProvider(sessionProviders.get(sessionId) ?? exec.agent.options.provider)) return
    const path = mutationPath(exec, result)
    if (!path) return
    report({
      hook_event_name: "post_tool_use",
      session_id: sessionId,
      tool_name: exec.name,
      path,
    })
  })

  ctx.on("agent/disposed", ({ agent }) => {
    const sessionId = String(agent.session.id)
    sessionCwds.delete(sessionId)
    sessionProviders.delete(sessionId)
    runningSessions.delete(sessionId)
  })

  ctx.effect(() => async () => {
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch
    const drain = Promise.allSettled([...pendingReports])
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 2_000))])
    lifecycle.abort("ducc-attribution disposed")
    reports.length = 0
  }, "ducc-attribution teardown")

  ctx.logger.info(
    `ducc-attribution: active for ${config.providerIds.join(", ")} on ${config.endpointPrefixes.join(", ")}`,
  )
}

export const testing = {
  mutationPath,
  normalizeJsonSchema,
  normalizeToolSchemas,
  runIteratorInContext,
}
