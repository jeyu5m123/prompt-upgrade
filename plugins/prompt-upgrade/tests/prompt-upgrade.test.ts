import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bigNumber, gate, parseQuestions, parseRewrite, wrap } from '../hooks/logic'

const PLUGIN = 'prompt-upgrade'
const PANE = 'prompt-upgrade'
const ROUGH = 'write a readme for my tool'
const UPGRADED = 'Write a short README for [project name] aimed at developers, with install steps and one example.'
const QUESTIONS = JSON.stringify({
  questions: [
    { q: 'Who is it for?', options: ['Developers', 'Customers'] },
    { q: 'How long should it be?', options: ['Short', 'Detailed'] },
  ],
})
const REWRITE = JSON.stringify({ prompt: UPGRADED, added: ['Audience: developers', 'Install steps', 'One example'] })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const COMPOSER = { kind: 'composer' } as const
const AT = { origin: COMPOSER, presentation: { isFullscreen: true, columns: 140 } }

const paneProps = (bodyColumns: number) => ({
  title: 'Prompt Upgrade',
  isFocused: true,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

/** The engine beneath the mod, answered from memory, and what reached it. */
const world = (on: On, options: { store?: Record<string, unknown>; narrow?: boolean; questions?: string; hangFirst?: boolean } = {}) => {
  const seen = { submitted: [] as string[], filled: [] as string[], logged: [] as string[], models: [] as string[], opened: 0, closed: 0 }
  mock.store(on, options.store ?? {})
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    seen.logged.push(String(e.text))
    return { value: undefined }
  })
  on('ui.open', () => {
    seen.opened += 1
    return { value: options.narrow ? { isPlaced: false as const, reason: 'below 110 columns' } : { isPlaced: true as const } }
  })
  on('ui.close', () => {
    seen.closed += 1
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('model.complete', async ($, e) => {
    seen.models.push(e.model)
    // As if the mod reloaded under it: the first call answers only much later.
    if (options.hangFirst && seen.models.length === 1) await clock.sleep(60_000)
    const isQuestions = (e.system ?? '').includes('multiple-choice')
    return { value: { isAnswered: true as const, text: isQuestions ? (options.questions ?? QUESTIONS) : REWRITE, usage: USAGE } }
  })
  return { seen, clock }
}

const startSession = ($: Engine) =>
  $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

describe('which prompts are intercepted', () => {
  const typed = (text: string, extra: Record<string, unknown> = {}) => ({ text, origin: COMPOSER, ...extra })

  test('auto on takes a plain rough prompt', () => {
    expect(gate(typed('build a landing page for my bakery'), true)).toEqual({ kind: 'take' })
  })

  test('auto off takes nothing', () => {
    expect(gate(typed('build a landing page for my bakery'), false)).toEqual({ kind: 'pass' })
  })

  test('pass-throughs', () => {
    expect(gate(typed('/review the diff', { command: { name: 'review', args: 'the diff' } }), true)).toEqual({ kind: 'pass' })
    expect(gate(typed('what is in this screenshot here', { attachments: [{ type: 'image' }] }), true)).toEqual({ kind: 'pass' })
    expect(gate(typed('also check the tests folder', { turnId: 't1' }), true)).toEqual({ kind: 'pass' })
    for (const reply of ['yes', 'keep going', 'ok thanks', 'Sounds good!', 'go ahead']) {
      expect(gate(typed(reply), true), reply).toEqual({ kind: 'pass' })
    }
    expect(gate(typed('ls -la in the repo root', { isMeta: true }), true)).toEqual({ kind: 'pass' })
  })

  test('the mod\'s own Run never loops back', () => {
    expect(gate({ text: UPGRADED, origin: { kind: 'plugin' } }, true)).toEqual({ kind: 'pass' })
  })

  test('> strips and sends as is', () => {
    expect(gate(typed('> just run the build please'), true)).toEqual({ kind: 'strip', text: 'just run the build please' })
    expect(gate(typed('>'), true)).toEqual({ kind: 'pass' })
  })
})

describe('reading model replies', () => {
  test('questions', () => {
    expect(parseQuestions(QUESTIONS)).toEqual([
      { q: 'Who is it for?', options: ['Developers', 'Customers'] },
      { q: 'How long should it be?', options: ['Short', 'Detailed'] },
    ])
    expect(parseQuestions('```json\n{"questions":[]}\n```')).toEqual([])
    const many = { questions: Array.from({ length: 5 }, (_, i) => ({ q: `Q${i}?`, options: ['a', 'b', 'c', 'd', 'e'] })) }
    const capped = parseQuestions(JSON.stringify(many))
    expect(capped).toHaveLength(3)
    expect(capped?.[0]?.options).toHaveLength(4)
    expect(parseQuestions(JSON.stringify({ questions: [{ q: 'One option?', options: ['only'] }] }))).toEqual([])
    expect(parseQuestions('I think you should ask about scope.')).toBeNull()
  })

  test('rewrite', () => {
    expect(parseRewrite(`Here you go: ${REWRITE}`)).toEqual({ prompt: UPGRADED, added: ['Audience: developers', 'Install steps', 'One example'] })
    expect(parseRewrite('{"added":["x"]}')).toBeNull()
    expect(parseRewrite('not json')).toBeNull()
  })

  test('layout helpers stay inside their width', () => {
    for (const width of [10, 37]) {
      for (const line of wrap(`${UPGRADED} supercalifragilisticexpialidocious`, width)) expect(line.length).toBeLessThanOrEqual(width)
    }
    expect(bigNumber(10)).toEqual(['╺┓  ┏━┓', ' ┃  ┃ ┃', '╺┻╸ ┗━┛'])
  })
})

describe('the pane', () => {
  test('full flow from /better to Run', async ($, on) => {
    const { seen, clock } = world(on, { store: { auto: true } })
    await startSession($)
    const reply = await $.command.run({ command: 'better', args: ROUGH, ...AT })
    expect(reply.text).toContain('Nothing is sent')
    await clock.settle()
    expect(seen.opened).toBe(1)

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(100) })
    expect(await ui.find({ text: 'Who is it for?' })).toBeDefined()
    await ui.press({ key: 'q0-o0' })
    expect(await ui.find({ text: '1 of 2 answered' })).toBeDefined()
    await ui.press({ key: 'q1-skip' })
    await ui.press({ key: 'upgrade' })
    await clock.settle()

    expect(await ui.find({ text: 'WHAT I ADDED' })).toBeDefined()
    expect(await ui.find({ text: /\[project name\]/ })).toBeDefined()
    await ui.press({ key: 'run' })

    expect(seen.models).toEqual(['haiku', 'sonnet'])
    expect(seen.submitted).toEqual([UPGRADED])
    // Run submitted with the mod's own origin: it went straight through, no second pane.
    expect(seen.opened).toBe(1)
    expect(seen.closed).toBe(1)
    await ui.unmount()
  })

  test('no helpful questions goes straight to the rewrite', async ($, on) => {
    const { seen, clock } = world(on, { questions: '{"questions":[]}' })
    await startSession($)
    await $.command.run({ command: 'better', args: ROUGH, ...AT })
    await clock.settle()
    expect(seen.models).toEqual(['haiku', 'sonnet'])
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(100) })
    expect(await ui.find({ key: 'run' })).toBeDefined()
  })

  test('Cancel puts the original back in the prompt box', async ($, on) => {
    const { seen, clock } = world(on)
    await startSession($)
    await $.command.run({ command: 'better', args: ROUGH, ...AT })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(100) })
    await ui.press({ key: 'cancel' })
    expect(seen.filled).toEqual([ROUGH])
    expect(seen.submitted).toEqual([])
    expect(seen.closed).toBe(1)
  })

  test('a window too narrow gives the words back in one line', async ($, on) => {
    const { seen, clock } = world(on, { narrow: true })
    await startSession($)
    await $.command.run({ command: 'better', args: ROUGH, ...AT })
    await clock.settle()
    expect(seen.filled).toEqual([ROUGH])
    expect(seen.logged).toHaveLength(1)
    expect(seen.models).toEqual([])
  })

  test('on and off switch the automatic mode', async ($, on) => {
    const { seen, clock } = world(on)
    await startSession($)
    const typed = { text: 'build a landing page for my bakery', origin: COMPOSER, wait: false }

    await $.prompt.submit(typed)
    expect(seen.submitted).toEqual([typed.text])
    expect(seen.opened).toBe(0)

    expect((await $.command.run({ command: 'better', args: 'on', ...AT })).text).toContain('on')
    await $.prompt.submit(typed)
    await clock.settle()
    expect(seen.submitted).toEqual([typed.text])
    expect(seen.opened).toBe(1)

    await $.prompt.submit({ ...typed, text: '> send this one raw please' })
    expect(seen.submitted).toEqual([typed.text, 'send this one raw please'])

    expect((await $.command.run({ command: 'better', args: 'off', ...AT })).text).toContain('off')
    await $.prompt.submit(typed)
    expect(seen.submitted).toEqual([typed.text, 'send this one raw please', typed.text])
  })

  test('every row fits a narrow and a wide pane', async ($, on) => {
    const { clock } = world(on)
    await startSession($)
    await $.command.run({ command: 'better', args: ROUGH, ...AT })
    await clock.settle()
    const fits = async () => {
      for (const width of [34, 130]) {
        const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(width) })
        for (const text of await ui.findAll({ type: 'Text' })) expect(text.text.length, text.text).toBeLessThanOrEqual(width)
        await ui.unmount()
      }
    }
    await fits()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(100) })
    await ui.press({ key: 'upgrade' })
    await clock.settle()
    expect(await ui.find({ key: 'run' })).toBeDefined()
    await ui.unmount()
    await fits()
  })

  test('a reload mid-step picks the step back up', async ($, on) => {
    const { seen, clock } = world(on, { hangFirst: true })
    await startSession($)
    await $.command.run({ command: 'better', args: ROUGH, ...AT })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(100) })
    expect(await ui.find({ text: /Reading your prompt/ })).toBeDefined()

    await startSession($)
    await clock.settle()
    expect(await ui.find({ text: 'Who is it for?' })).toBeDefined()

    // The stale reply lands later and changes nothing.
    await ui.press({ key: 'q0-o1' })
    await clock.advance(60_000)
    expect(await ui.find({ text: '1 of 2 answered' })).toBeDefined()
    expect(seen.models).toEqual(['haiku', 'haiku'])
  })
})
