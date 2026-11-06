export type Issue = {
  id: number
  title: string
  detail?: string
  file?: string
  createdAt: number
  /** Absent on issues noted before priorities existed: those are `medium`. */
  priority?: Priority
  /** The background session started for it from the pane, if any. */
  sessionId?: string
  /** The GitHub issue created for it from the pane, if any. */
  githubUrl?: string
  /** That GitHub issue's status, as `gh issue view` last reported it; once it is closed the issue is removed. */
  github?: GithubStatus
}

export type Priority = 'high' | 'medium' | 'low'

export type GithubStatus = {
  state: 'OPEN' | 'CLOSED'
  /** Its Status column on the first project board that has one, e.g. `📋 To do`. */
  board?: string
}

/** What `$.store` keeps per repository, under `issues:<main working tree root>` (`issues:<cwd>` outside one). */
export type Stored = { nextId: number; items: Issue[] }

declare module 'claude-code' {
  interface PluginState {
    'noticed-issues': {
      /** This project's open issues, mirrored from `$.store`. */
      issues: Issue[]
      /** The priority groups folded in the pane, mirrored from `$.store` (`collapsed`). */
      collapsed: Priority[]
    }
  }
}
