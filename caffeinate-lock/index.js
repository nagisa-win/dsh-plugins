import { spawn } from "node:child_process"

export const name = "caffeinate-lock"

const STATE_KEY = Symbol.for("dsh.caffeinate-lock")

/**
 * One semaphore per Host process, shared by every copy of this module.
 * `globalThis` survives HMR reloads, so a reload reuses the running
 * `caffeinate` child instead of spawning a second one.
 */
function sharedState() {
  const existing = globalThis[STATE_KEY]
  if (existing) return existing
  const created = { count: 0, child: null }
  globalThis[STATE_KEY] = created
  return created
}

function spawnLock(state, command, args, logger) {
  if (state.child) return
  try {
    const child = spawn(command, args, { stdio: "ignore" })
    state.child = child
    child.on("error", (error) => {
      if (state.child === child) state.child = null
      logger?.warn(`caffeinate-lock: ${command} failed: ${error.message}`)
    })
    child.on("exit", () => {
      if (state.child === child) state.child = null
    })
    logger?.info(`caffeinate-lock: acquired (${command} ${args.join(" ")})`)
  } catch (error) {
    logger?.warn(`caffeinate-lock: ${error.message}`)
  }
}

function killLock(state, logger) {
  const child = state.child
  state.child = null
  if (!child) return
  child.kill()
  logger?.info("caffeinate-lock: released")
}

export function apply(ctx, rawConfig = {}) {
  const command = rawConfig.command ?? "caffeinate"
  const args = rawConfig.args ?? ["-i", "-w", String(process.pid)]
  const state = sharedState()
  const held = new Set()

  if (process.platform !== "darwin") {
    ctx.logger.warn("caffeinate-lock: caffeinate is macOS-only; sleep lock disabled")
    return
  }

  function acquire() {
    state.count += 1
    if (state.count > 1) return
    spawnLock(state, command, args, ctx.logger)
  }

  function release() {
    if (state.count === 0) return
    state.count -= 1
    if (state.count > 0) return
    killLock(state, ctx.logger)
  }

  ctx.on("agent/status", ({ agent, status }) => {
    const id = String(agent?.session?.id ?? "")
    if (!id) return
    if (status === "running") {
      if (held.has(id)) return
      held.add(id)
      acquire()
      return
    }
    if (!held.delete(id)) return
    release()
  })

  ctx.on("agent/disposed", ({ agent }) => {
    const id = String(agent?.session?.id ?? "")
    if (!id || !held.delete(id)) return
    release()
  })

  ctx.effect(() => () => {
    for (const _ of held) release()
    held.clear()
  }, "caffeinate-lock teardown")

  ctx.logger.info("caffeinate-lock: armed")
}