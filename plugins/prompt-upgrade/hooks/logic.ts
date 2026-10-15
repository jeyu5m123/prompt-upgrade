import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'

import type { Answer, Question } from '../types'

// What decides whether a typed prompt goes to the pane.

export type Gate = { kind: 'pass' } | { kind: 'strip'; text: string } | { kind: 'take' }

type Submitted = {
  text: string
  command?: unknown
  isMeta?: true
  attachments?: readonly unknown[]
  turnId?: string
  origin: { kind: string }
}

const ACK =
  /^(y|yes|yep|yeah|yup|n|no|nope|ok|okay|k|sure|thanks|thank you|thx|ty|go|go on|go ahead|continue|keep going|carry on|do it|proceed|sounds good|looks good|lgtm|perfect|great|nice|good|stop|done|next|again|retry|try again)[\s.!?]*$/i

/** Short replies that should never be upgraded. */
export const isShortReply = (text: string): boolean => {
  const trimmed = text.trim()
  return trimmed.split(/\s+/).length <= 2 || ACK.test(trimmed)
}

export const gate = (e: Submitted, isAuto: boolean): Gate => {
  // Only the person's own Enter is ever taken; this plugin's own Run submits
  // with a plugin origin, so it can never come back here.
  if (!isAuto || e.origin.kind !== 'composer' || e.command !== undefined || e.isMeta) return { kind: 'pass' }
  const trimmed = e.text.trimStart()
  if (trimmed.startsWith('>')) {
    const rest = trimmed.slice(1).trimStart()
    return rest ? { kind: 'strip', text: rest } : { kind: 'pass' }
  }
  if ((e.attachments?.length ?? 0) > 0 || e.turnId !== undefined) return { kind: 'pass' }
  if (trimmed.startsWith('/') || trimmed.startsWith('!') || isShortReply(trimmed)) return { kind: 'pass' }
  return { kind: 'take' }
}

// The two model calls.

export const QUESTION_MODEL = 'haiku'
export const REWRITE_MODEL = 'sonnet'

const QUESTIONS_SYSTEM = `You help a person sharpen a rough prompt before they send it to Claude Code, an AI coding assistant.
Choose at most three multiple-choice questions whose answers would most improve the result.
Ask only about what the prompt leaves open and what would change the outcome: scope, audience, format, constraints, what done looks like.
Never ask about something the prompt already answers. If the prompt is already clear enough, return no questions.
Each question is under 12 words. Each has 2 to 4 options of 1 to 5 words.
Reply with JSON only, no other text: {"questions":[{"q":"...","options":["...","..."]}]}`

const REWRITE_SYSTEM = `You rewrite a person's rough prompt into a clear, complete request for Claude Code, an AI coding assistant.
Rules:
- Keep exactly what they meant. Do not change or widen the task.
- Add a clear goal, who it is for, the format of the result, and what done looks like.
- Use the answers given. Leave out anything they skipped.
- Never invent facts, names, numbers, prices, files or tools. Where something needed is unknown, write a placeholder in square brackets, like [file name].
- Write it as one request the person could have typed themselves: plain language, first person, no headings, no markdown, no preamble.
Reply with JSON only, no other text: {"prompt":"the upgraded prompt","added":["short phrase for each thing you added"]}
Give at most 6 items in "added", each under 8 words.`

export const questionsRequest = (original: string): ModelCompleteRequest => ({
  model: QUESTION_MODEL,
  system: QUESTIONS_SYSTEM,
  prompt: `<prompt>\n${original}\n</prompt>`,
  maxTokens: 600,
  effort: 'low',
  timeoutMs: 45_000,
})

export const rewriteRequest = (original: string, questions: readonly Question[], answers: readonly Answer[]): ModelCompleteRequest => {
  const answered = questions.flatMap((question, i) => {
    const answer = answers[i]
    return answer && 'text' in answer ? [`- ${question.q} ${answer.text}`] : []
  })
  const facts = answered.length ? `\n\n<answers>\n${answered.join('\n')}\n</answers>` : ''
  return {
    model: REWRITE_MODEL,
    system: REWRITE_SYSTEM,
    prompt: `<prompt>\n${original}\n</prompt>${facts}`,
    maxTokens: 2000,
    timeoutMs: 90_000,
  }
}

const jsonIn = (text: string): unknown => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** The questions in a reply: at most 3, each with 2 to 4 options; null when unreadable. */
export const parseQuestions = (text: string): Question[] | null => {
  const data = jsonIn(text)
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { questions?: unknown }).questions)) return null
  const list = (data as { questions: unknown[] }).questions
  return list
    .flatMap(item => {
      const { q, options } = (item ?? {}) as { q?: unknown; options?: unknown }
      if (!isText(q) || !Array.isArray(options)) return []
      const kept = [...new Set(options.filter(isText).map(o => o.trim()))].slice(0, 4)
      return kept.length >= 2 ? [{ q: q.trim(), options: kept }] : []
    })
    .slice(0, 3)
}

/** The upgraded prompt and what it added; null when unreadable. */
export const parseRewrite = (text: string): { prompt: string; added: string[] } | null => {
  const data = jsonIn(text) as { prompt?: unknown; added?: unknown } | undefined
  if (!data || !isText(data.prompt)) return null
  const added = Array.isArray(data.added) ? data.added.filter(isText).map(a => a.trim()).slice(0, 6) : []
  return { prompt: data.prompt.trim(), added }
}

/** A calm sentence for a model call that came back without text. */
export const describeFailure = (result: Exclude<ModelCompleteResult, { isAnswered: true }>): string => {
  if (result.reason === 'aborted') return 'The model took too long to answer.'
  if (result.reason === 'empty-reply') return 'The model answered with nothing.'
  if (result.error === 'rate_limit') return 'You have hit a rate limit for now.'
  if (result.error === 'overloaded') return 'The model service is busy right now.'
  if (result.error === 'authentication_failed') return 'Claude Code could not sign in to the model.'
  return `The model call failed${result.status === null ? '' : ` (status ${result.status})`}.`
}

// Text layout.

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length

export const clip = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

/** Word-wraps to `width`, keeping line breaks and splitting words longer than a line. */
export const wrap = (text: string, width: number): string[] => {
  const room = Math.max(1, width)
  return text.split('\n').flatMap(paragraph => {
    const lines: string[] = []
    let line = ''
    for (const raw of paragraph.split(/\s+/).filter(Boolean)) {
      let word = raw
      while (word.length > room) {
        if (line) lines.push(line)
        lines.push(word.slice(0, room))
        word = word.slice(room)
        line = ''
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= room) line += ` ${word}`
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
    return lines
  })
}

/** Caps a list of lines, the last kept line marking the cut. */
export const cap = (lines: string[], max: number, width: number): string[] =>
  lines.length <= max ? lines : [...lines.slice(0, max - 1), clip(`${lines[max - 1]} …`, width)]

const DIGITS: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
}

/** A number drawn three rows tall in heavy box-drawing characters. */
export const bigNumber = (n: number): [string, string, string] => {
  const glyphs = String(Math.max(0, Math.round(n))).split('').map(d => DIGITS[d] ?? DIGITS['0']!)
  return [0, 1, 2].map(row => glyphs.map(g => g[row]).join(' ')) as [string, string, string]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const when = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
