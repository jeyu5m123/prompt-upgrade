export type Question = { q: string; options: string[] }

/** A chosen or typed answer, a skip, or nothing yet. */
export type Answer = { text: string } | { skipped: true } | null

export type Step = 'input' | 'reading' | 'questions' | 'rewriting' | 'review' | 'error' | 'history'

export type Entry = { id: string; at: number; original: string; rewrite: string; added: string[] }

export type Flow = {
  id: string
  step: Step
  original: string
  questions: Question[]
  answers: Answer[]
  /** Which question's "Other" field is open. */
  otherFor: number | null
  rewrite: string
  added: string[]
  editing: boolean
  /** Token of the model call in flight; a reply under another token is dropped. */
  pending: string | null
  error: { during: 'questions' | 'rewrite'; detail: string } | null
  note: { text: string; tone: 'good' | 'warn' } | null
  /** Reopened from history: Cancel then just closes. */
  fromHistory: boolean
  entries: Entry[]
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': { flow: Flow | null }
  }
}
