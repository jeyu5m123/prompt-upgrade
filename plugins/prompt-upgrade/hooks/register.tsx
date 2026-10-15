import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, ModelCompleteRequest, Register, RenderChildren } from 'claude-code'

import type { Answer, Entry, Flow, Question, Step } from '../types'
import {
  bigNumber,
  cap,
  clip,
  describeFailure,
  gate,
  parseQuestions,
  parseRewrite,
  questionsRequest,
  rewriteRequest,
  when,
  wordCount,
  wrap,
} from './logic'

type D = EngineInterface

const PANE = 'prompt-upgrade'
const HISTORY_SIZE = 20
const flow = atom({ plugin: 'prompt-upgrade', key: 'flow' } as const, null)

const GOLD = '#F2C46D'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const INK = '#0D1117'

// The module's own: lost on reload, which the token in `pending` covers.
let inflight: AbortController | undefined

const newId = () => Math.random().toString(36).slice(2, 10)

const blank = (original: string, step: Step): Flow => ({
  id: newId(),
  step,
  original,
  questions: [],
  answers: [],
  otherFor: null,
  rewrite: '',
  added: [],
  editing: false,
  pending: null,
  error: null,
  note: null,
  fromHistory: false,
  entries: [],
})

const setFlow = ($: D, value: Flow | null) => update($, flow, () => value)
const patch = ($: D, change: (f: Flow) => Flow) => update($, flow, f => (f ? change(f) : f))

const isAuto = async ($: D) => (await $.store.get('auto')) === true

const loadHistory = async ($: D): Promise<Entry[]> => {
  const saved = await $.store.get('history')
  return Array.isArray(saved) ? (saved as Entry[]) : []
}

const remember = async ($: D, f: Flow) => {
  if (f.fromHistory || !f.rewrite) return
  const entry: Entry = { id: f.id, at: await $.clock.now(), original: f.original, rewrite: f.rewrite, added: f.added }
  const kept = (await loadHistory($)).filter(one => one.id !== f.id)
  await $.store.set('history', [...kept, entry].slice(-HISTORY_SIZE))
}

/** Opens the pane; when it cannot be placed, gives the words back and says so once. */
const show = async ($: D, original: string): Promise<boolean> => {
  const opened = await $.ui.open({ id: PANE, title: 'Prompt Upgrade', focus: true, closeOnEscape: true, rows: 32, columns: 104 })
  if (opened.isPlaced) return true
  inflight?.abort()
  await setFlow($, null)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  if (original) await $.prompt.fill({ text: original })
  $.ui.log('Prompt Upgrade needs a wider window, so your prompt is back in the prompt box.')
  return false
}

/** Runs background work; a failure gives the words back with one plain line. */
const safely = (work: Promise<unknown>, $: D, original: string) =>
  void work.catch(async () => {
    await setFlow($, null).catch(() => undefined)
    if (original) await $.prompt.fill({ text: original }).catch(() => undefined)
    $.ui.log('Prompt Upgrade hit a problem. Your prompt is back in the prompt box.')
  })

const ask = async ($: D, request: ModelCompleteRequest): Promise<{ text: string } | { failure: string }> => {
  inflight = new AbortController()
  try {
    const result = await $.model.complete(request, { signal: inflight.signal })
    return result.isAnswered ? { text: result.text } : { failure: describeFailure(result) }
  } catch {
    return { failure: 'Claude Code would not send the request.' }
  }
}

/** Moves to a waiting step under a fresh token; null when there is no upgrade. */
const claim = async ($: D, step: 'reading' | 'rewriting', token: string) => {
  const f = await patch($, cur => ({ ...cur, step, pending: token, error: null, note: null, editing: false, otherFor: null }))
  return f?.pending === token ? f : null
}

const askQuestions = async ($: D) => {
  const token = newId()
  const f = await claim($, 'reading', token)
  if (!f) return
  const reply = await ask($, questionsRequest(f.original))
  const now = await patch($, cur => {
    if (cur.pending !== token) return cur
    if ('failure' in reply) return { ...cur, pending: null, step: 'error', error: { during: 'questions', detail: reply.failure } }
    // Questions are optional: an unreadable list goes straight to the rewrite.
    const questions = parseQuestions(reply.text) ?? []
    return { ...cur, pending: null, step: questions.length ? 'questions' : 'rewriting', questions, answers: questions.map(() => null) }
  })
  if (now?.step === 'rewriting' && now.pending === null) await rewrite($)
}

const rewrite = async ($: D) => {
  const token = newId()
  const f = await claim($, 'rewriting', token)
  if (!f) return
  const reply = await ask($, rewriteRequest(f.original, f.questions, f.answers))
  const parsed = 'text' in reply ? parseRewrite(reply.text) : null
  const now = await patch($, cur => {
    if (cur.pending !== token) return cur
    if ('failure' in reply) return { ...cur, pending: null, step: 'error', error: { during: 'rewrite', detail: reply.failure } }
    if (!parsed) return { ...cur, pending: null, step: 'error', error: { during: 'rewrite', detail: 'The rewrite came back in a shape I could not read.' } }
    return { ...cur, pending: null, step: 'review', rewrite: parsed.prompt, added: parsed.added }
  })
  if (now?.step === 'review' && parsed && now.rewrite === parsed.prompt) await remember($, now)
}

const begin = async ($: D, original: string) => {
  inflight?.abort()
  await setFlow($, blank(original, 'reading'))
  if (await show($, original)) await askQuestions($)
}

const openBlank = async ($: D, step: 'input' | 'history') => {
  inflight?.abort()
  const entries = step === 'history' ? [...(await loadHistory($))].reverse() : []
  await setFlow($, { ...blank('', step), entries })
  await show($, '')
}

/** Closes the pane and forgets the upgrade; true when it gave the original back. */
const finish = async ($: D, giveBack: boolean) => {
  const f = await read($, flow)
  inflight?.abort()
  await setFlow($, null)
  await $.ui.close({ id: PANE })
  if (giveBack && f && !f.fromHistory && f.original) await $.prompt.fill({ text: f.original })
}

const run = async ($: D, text: string) => {
  const f = await read($, flow)
  const final = text.trim()
  if (!final) return
  if (f) await remember($, { ...f, rewrite: final })
  await finish($, false)
  // A plugin origin: the gate never takes it, so it cannot loop back.
  await $.prompt.submit({ text: final, asUser: true })
}

const answer = ($: D, index: number, value: Answer) =>
  patch($, cur => ({ ...cur, otherFor: null, answers: cur.answers.map((a, i) => (i === index ? value : a)) }))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'better',
        description: 'Upgrade a rough prompt before it is sent',
        argumentHint: '<prompt> | on | off | history',
      })
      $.ui.status((await isAuto($)) ? 'better: auto' : undefined)
      // A reload mid-step: pick the waiting call back up.
      const f = await read($, flow)
      if (f?.pending && f.step === 'reading') safely(askQuestions($), $, f.original)
      if (f?.pending && f.step === 'rewriting') safely(rewrite($), $, f.original)
    } catch {
      // The session goes on without the mod rather than failing to start.
    }
    return next(e)
  })

  // Answers at once; the pane opens in the background.
  on('command.run', { command: 'better' }, async ($, e) => {
    const typed = e.args.trim()
    const word = typed.toLowerCase()
    if (word === 'on' || word === 'off') {
      await $.store.set('auto', word === 'on')
      $.ui.status(word === 'on' ? 'better: auto' : undefined)
      return {
        text:
          word === 'on'
            ? 'Automatic mode is on: prompts you type open in Prompt Upgrade first. Start one with > to send it as is.'
            : 'Automatic mode is off: prompts go straight through.',
      }
    }
    if (word === 'history') {
      safely(openBlank($, 'history'), $, '')
      return { text: 'Opening your last upgrades.' }
    }
    if (!typed) {
      safely(openBlank($, 'input'), $, '')
      return { text: 'Type the prompt to upgrade in the pane.' }
    }
    safely(begin($, typed), $, typed)
    return { text: 'Upgrading your prompt. Nothing is sent until you press Run.' }
  }).catch(() => ({ text: 'Prompt Upgrade could not do that just now. Nothing was sent.' }))

  on('prompt.submit', async ($, e, next) => {
    const decision = gate(e, await isAuto($))
    if (decision.kind === 'pass') return next(e)
    if (decision.kind === 'strip') return next({ ...e, text: decision.text })
    const original = e.text.trim()
    safely(begin($, original), $, original)
    // Answered without `next`: nothing enters the session until Run.
    return { text: e.text }
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    // The person's close mark or Escape is a Cancel: the words go back.
    const f = e.origin.kind === 'person' ? await read($, flow) : null
    if (f) {
      inflight?.abort()
      await setFlow($, null)
      if (!f.fromHistory && f.original) await $.prompt.fill({ text: f.original })
    }
    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const kit: Kit = { Box: table.Box, Text: table.Text, Button: table.Button, Input: 'Input' in table ? table.Input : undefined }
    const width = Math.max(24, e.props.bodyColumns)
    return draw($, kit, width, await read($, flow))
  })
}

// Drawing. Reads only: every change happens in a press or an input handler.

type Table = Elements['terminal']
type Kit = { Box: Table['Box']; Text: Table['Text']; Button: Table['Button']; Input: Table['Input'] | undefined }

const STEPS = [
  { long: 'Your prompt', short: 'Prompt' },
  { long: 'Questions', short: 'Ask' },
  { long: 'Rewrite', short: 'Write' },
  { long: 'Review', short: 'Review' },
]

const stepIndex = (f: Flow): number => {
  if (f.step === 'error') return f.error?.during === 'rewrite' ? 2 : 1
  return { input: 0, reading: 0, questions: 1, rewriting: 2, review: 3, history: 0 }[f.step]
}

const draw = ($: D, kit: Kit, width: number, f: Flow | null) => {
  const { Box, Text, Button, Input } = kit

  const title = 'PROMPT UPGRADE'
  const header = (
    <Box flexDirection="column" width={width}>
      <Text color={TEXT} weight="bold" wrap="truncate-end">
        {clip(title, width)}
      </Text>
      <Text wrap="truncate-end">
        <Text color={GOLD}>{'━'.repeat(Math.min(title.length, width))}</Text>
        <Text color={LINE}>{'─'.repeat(Math.max(0, width - title.length))}</Text>
      </Text>
    </Box>
  )

  const heading = (label: string, tone = MUTED) => (
    <Text wrap="truncate-end">
      <Text color={tone}>{clip(label, width)}</Text>
      <Text color={LINE}>{` ${'─'.repeat(Math.max(0, width - label.length - 1))}`}</Text>
    </Text>
  )

  const tracker = (current: number) => {
    const mark = (i: number) => (i < current ? '✓' : i === current ? '●' : '○')
    const tone = (i: number) => (i < current ? GREEN : i === current ? GOLD : MUTED)
    const fits = (pick: 'long' | 'short', joint: string) =>
      STEPS.reduce((n, s) => n + s[pick].length + 2, 0) + joint.length * 3 <= width
    const layout = fits('long', ' ── ') ? (['long', ' ── '] as const) : fits('short', ' ─ ') ? (['short', ' ─ '] as const) : null
    if (!layout) {
      return (
        <Text color={GOLD} wrap="truncate-end">
          {clip(`Step ${current + 1} of 4  ${STEPS[current]!.long}`, width)}
        </Text>
      )
    }
    const [pick, joint] = layout
    return (
      <Text wrap="truncate-end">
        {STEPS.map((s, i) => (
          <Text>
            <Text color={tone(i)} weight={i === current ? 'bold' : 'regular'}>{`${mark(i)} ${s[pick]}`}</Text>
            {i < STEPS.length - 1 ? <Text color={LINE}>{joint}</Text> : ''}
          </Text>
        ))}
      </Text>
    )
  }

  const card = (text: string, border: string, w: number, maxLines: number, tone = TEXT) => (
    <Box borderStyle="round" borderColor={border} paddingX={1} width={w} flexDirection="column">
      {cap(wrap(text, w - 4), maxLines, w - 4).map(line => (
        <Text color={tone} wrap="truncate-end">
          {line || ' '}
        </Text>
      ))}
    </Box>
  )

  const chip = (key: string, label: string, tone: 'gold' | 'slate' | 'green', onPress: () => unknown, autoFocus?: true) => (
    <Button key={key} plain autoFocus={autoFocus} onPress={() => void onPress()}>
      <Text
        backgroundColor={tone === 'gold' ? GOLD : tone === 'green' ? GREEN : LINE}
        color={tone === 'slate' ? TEXT : INK}
        weight={tone === 'slate' ? 'regular' : 'bold'}
      >
        {` ${clip(label, width - 2)} `}
      </Text>
    </Button>
  )

  const quiet = (key: string, label: string, onPress: () => unknown) => (
    <Button key={key} plain onPress={() => void onPress()}>
      <Text color={MUTED}>{label}</Text>
    </Button>
  )

  const row = (...children: RenderChildren[]) => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={width}>
      {children}
    </Box>
  )

  const line = (text: string, tone = MUTED) => (
    <Text color={tone} wrap="truncate-end">
      {clip(text, width)}
    </Text>
  )

  const frame = (current: number | null, ...body: RenderChildren[]) => (
    <Box flexDirection="column" width={width} rowGap={1}>
      <Box flexDirection="column">
        {header}
        {current === null ? '' : tracker(current)}
      </Box>
      {body}
    </Box>
  )

  if (!f) return frame(null, line('Nothing to upgrade. Type /better followed by a rough prompt.'))

  const cancel = quiet('cancel', 'Cancel', () => finish($, true))
  const yours = (
    <Box flexDirection="column">
      {heading('YOUR PROMPT')}
      {card(f.original, LINE, width, 8)}
    </Box>
  )

  if (f.step === 'input') {
    return frame(
      0,
      <Box flexDirection="column">
        {heading('WHAT DO YOU WANT TO ASK?')}
        {Input ? (
          <Input
            key="draft"
            rows={3}
            autoFocus
            placeholder="Type a rough prompt. Enter upgrades it."
            submitLabel="upgrade"
            onSubmit={value => void (value.trim() && begin($, value.trim()))}
          />
        ) : (
          line('Type /better followed by your prompt.', TEXT)
        )}
      </Box>,
      row(cancel),
    )
  }

  if (f.step === 'reading' || f.step === 'rewriting') {
    const doing =
      f.step === 'reading'
        ? 'Reading your prompt and choosing the questions that matter most.'
        : 'Rewriting your prompt with your answers.'
    return frame(stepIndex(f), yours, <Box flexDirection="column">{wrap(doing, width).map(text => line(text))}</Box>, row(cancel))
  }

  if (f.step === 'questions') {
    const answered = f.answers.filter(a => a && 'text' in a).length
    const skipped = f.answers.filter(a => a && 'skipped' in a).length
    const isDone = answered + skipped === f.questions.length
    return frame(
      1,
      yours,
      <Box flexDirection="column" rowGap={1}>
        {heading('QUESTIONS')}
        {f.questions.map((question, i) => questionBlock(question, i, f.answers[i] ?? null, f.otherFor === i))}
      </Box>,
      <Box flexDirection="column">
        {line(`${answered} of ${f.questions.length} answered${skipped ? `, ${skipped} skipped` : ''}`, answered ? GREEN : MUTED)}
        {row(chip('upgrade', isDone ? 'Upgrade now' : 'Skip the rest, upgrade now', 'gold', () => rewrite($)), cancel)}
      </Box>,
    )
  }

  function questionBlock(question: Question, i: number, given: Answer, isTyping: boolean) {
    const isAnswered = given !== null && 'text' in given
    const isSkipped = given !== null && 'skipped' in given
    const badge = isAnswered ? ' ✓ ' : isSkipped ? ' – ' : ` ${i + 1} `
    const badgeTone = isAnswered ? GREEN : isSkipped ? LINE : GOLD
    const asked = wrap(question.q, width - 4)
    const custom = isAnswered && !question.options.includes(given.text) ? given.text : null
    return (
      <Box flexDirection="column" width={width}>
        {asked.map((text, n) => (
          <Text wrap="truncate-end">
            {n === 0 ? (
              <Text backgroundColor={badgeTone} color={isSkipped ? MUTED : INK} weight="bold">
                {badge}
              </Text>
            ) : (
              '   '
            )}
            <Text color={isSkipped ? MUTED : TEXT}>{` ${text}`}</Text>
          </Text>
        ))}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={4} width={width}>
          {question.options.map((option, n) =>
            chip(`q${i}-o${n}`, clip(option, width - 8), isAnswered && given.text === option ? 'gold' : 'slate', () =>
              answer($, i, { text: option }),
            ),
          )}
          {Input
            ? chip(`q${i}-other`, custom ? clip(`Other: ${custom}`, width - 8) : 'Other (type it)', custom ? 'gold' : 'slate', () =>
                patch($, cur => ({ ...cur, otherFor: i })),
              )
            : ''}
          {quiet(`q${i}-skip`, isSkipped ? 'Skipped' : 'Skip', () => answer($, i, { skipped: true }))}
        </Box>
        {isTyping && Input ? (
          <Box paddingLeft={4} width={width}>
            <Input key={`q${i}-text`} autoFocus placeholder="Type your answer" submitLabel="save" onSubmit={value => void (value.trim() && answer($, i, { text: value.trim() }))} />
          </Box>
        ) : (
          ''
        )}
      </Box>
    )
  }

  if (f.step === 'error') {
    const during = f.error?.during === 'rewrite' ? 'rewriting your prompt' : 'choosing questions'
    return frame(
      stepIndex(f),
      <Box borderStyle="round" borderColor={AMBER} paddingX={1} width={width} flexDirection="column">
        {wrap(`Something went wrong while ${during}.`, width - 4).map(text => line(text, AMBER))}
        {line('Your prompt is safe.', TEXT)}
        {wrap(f.error?.detail ?? '', width - 4).map(text => line(text))}
      </Box>,
      row(
        chip('retry', 'Try again', 'gold', () => (f.error?.during === 'rewrite' ? rewrite($) : askQuestions($)), true),
        chip('original', 'Send my original', 'slate', () => run($, f.original)),
        cancel,
      ),
    )
  }

  if (f.step === 'history') {
    return frame(
      null,
      <Box flexDirection="column">
        {heading(`LAST UPGRADES  ${f.entries.length} of ${HISTORY_SIZE}`)}
        {f.entries.length === 0
          ? line('No upgrades yet. Try /better followed by a rough prompt.')
          : f.entries.map(entry => (
              <Button
                key={`h-${entry.id}`}
                plain
                onPress={() =>
                  void setFlow($, {
                    ...blank(entry.original, 'review'),
                    id: entry.id,
                    rewrite: entry.rewrite,
                    added: entry.added,
                    fromHistory: true,
                  })
                }
              >
                <Text color={MUTED}>{`${when(entry.at)}  `}</Text>
                <Text color={TEXT}>{clip(entry.original.replace(/\s+/g, ' '), width - 14)}</Text>
              </Button>
            ))}
      </Box>,
      row(quiet('close', 'Close', () => finish($, false))),
    )
  }

  // Review.
  const before = wordCount(f.original)
  const after = wordCount(f.rewrite)
  const tiles = [
    { label: 'WORDS BEFORE', value: before, tone: TEXT },
    { label: 'WORDS AFTER', value: after, tone: GOLD },
    { label: 'DETAILS ADDED', value: f.added.length, tone: GREEN },
  ]
  const tileWidth = (t: (typeof tiles)[number]) => Math.max(t.label.length, bigNumber(t.value)[0].length) + 4
  const tilesFit = tiles.reduce((n, t) => n + tileWidth(t) + 1, -1) <= width
  const numbers = tilesFit ? (
    <Box flexDirection="row" columnGap={1}>
      {tiles.map(t => (
        <Box borderStyle="round" borderColor={LINE} paddingX={1} width={tileWidth(t)} flexDirection="column">
          {bigNumber(t.value).map(text => (
            <Text color={t.tone}>{text}</Text>
          ))}
          <Text color={MUTED}>{t.label}</Text>
        </Box>
      ))}
    </Box>
  ) : (
    <Text wrap="truncate-end">
      <Text color={TEXT}>{`${before}`}</Text>
      <Text color={MUTED}>{' → '}</Text>
      <Text color={GOLD}>{`${after}`}</Text>
      <Text color={MUTED}>{' words, '}</Text>
      <Text color={GREEN}>{`${f.added.length}`}</Text>
      <Text color={MUTED}>{' added'}</Text>
    </Text>
  )

  const buttons = row(
    chip('run', 'Run it', 'gold', () => run($, f.rewrite), true),
    Input ? chip('edit', f.editing ? 'Stop editing' : 'Edit', 'slate', () => patch($, cur => ({ ...cur, editing: !cur.editing, note: null }))) : '',
    chip('copy', 'Copy', 'slate', async () => {
      const copied = await $.ui.copy({ text: f.rewrite })
      await patch($, cur => ({
        ...cur,
        note: copied.isCopied ? { text: 'Copied to the clipboard.', tone: 'good' } : { text: 'Could not reach the clipboard here.', tone: 'warn' },
      }))
    }),
    cancel,
  )

  const added = (
    <Box flexDirection="column">
      {heading('WHAT I ADDED')}
      {f.added.length === 0
        ? line('Nothing new: your prompt was already clear.')
        : f.added.map(item => (
            <Text wrap="truncate-end">
              <Text color={GREEN}>{'+ '}</Text>
              <Text color={TEXT}>{clip(item, width - 2)}</Text>
            </Text>
          ))}
    </Box>
  )

  const editor =
    f.editing && Input ? (
      <Box flexDirection="column">
        {heading('EDIT THE UPGRADE', GOLD)}
        <Input
          key="edit-text"
          autoFocus
          rows={Math.min(12, Math.max(3, wrap(f.rewrite, width - 2).length))}
          value={f.rewrite}
          submitLabel="run"
          onSubmit={value => void run($, value)}
        />
      </Box>
    ) : (
      ''
    )

  const isSideBySide = width >= 60
  const half = isSideBySide ? Math.floor((width - 1) / 2) : width
  const side = (label: string, tone: string, text: string, border: string) => (
    <Box flexDirection="column" width={half}>
      <Text color={tone} wrap="truncate-end">
        {clip(label, half)}
      </Text>
      {card(text, border, half, 40)}
    </Box>
  )
  const compare = (
    <Box flexDirection={isSideBySide ? 'row' : 'column'} columnGap={1} rowGap={1} width={width}>
      {side('YOUR PROMPT', MUTED, f.original, LINE)}
      {side('UPGRADED', GOLD, f.rewrite, GOLD)}
    </Box>
  )

  return frame(
    3,
    numbers,
    <Box flexDirection="column">
      {buttons}
      {f.note ? line(f.note.text, f.note.tone === 'good' ? GREEN : AMBER) : ''}
    </Box>,
    added,
    editor,
    compare,
  )
}
