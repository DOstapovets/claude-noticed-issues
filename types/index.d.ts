export type Issue = {
  id: number
  title: string
  detail?: string
  file?: string
  createdAt: number
  /** Absent on issues noted before priorities existed: those are `medium`. */
  priority?: Priority
  /** The session that noted it (`$.session.id()`); absent on issues noted before 0.16. */
  noticedIn?: string
  /** The background session started for it from the pane, if any. */
  sessionId?: string
  /** The GitHub issue created for it from the pane, if any. */
  githubUrl?: string
  /** That GitHub issue's status, as `gh issue view` last reported it; once it is closed the issue is removed. */
  github?: GithubStatus
}

export type Priority = 'high' | 'medium' | 'low'

export type Tab = 'all' | 'session' | 'projects'

export type GithubStatus = {
  state: 'OPEN' | 'CLOSED'
  /** Its Status column on the first project board that has one, e.g. `📋 To do`. */
  board?: string
}

/** What `$.store` keeps per repository, under `issues:<main working tree root>` (`issues:<cwd>` outside one). */
export type Stored = {
  nextId: number
  items: Issue[]
  /** The repository's `origin`, as the session that last changed the list saw it; absent outside a repository and on lists from before 0.22. */
  remote?: string
  /** When the list last changed; absent on lists from before 0.22. */
  updatedAt?: number
}

/** What `$.store` keeps per repository under `rule:<root>`: when the analysis was offered, and the rule it saved, if any. */
export type Rule = {
  askedAt: number
  /** When to note an issue in this repository, added to the context of its sessions. */
  text?: string
  savedAt?: number
}

/** Another project's list, as the pane's Projects tab shows it. */
export type Project = {
  /** The key's directory: the main working tree's root, or the directory outside a repository. */
  root: string
  remote?: string
  updatedAt?: number
  items: Issue[]
}

declare module 'claude-code' {
  interface PluginState {
    'noticed-issues': {
      /** This project's open issues, mirrored from `$.store`. */
      issues: Issue[]
      /** The priority groups folded in the pane, mirrored from `$.store` (`collapsed`). */
      collapsed: Priority[]
      /** The pane's tab: every issue, only those this session noted, or the other projects. */
      tab: Tab
      /** Every other project with a list in `$.store`, those with issues first. */
      projects: Project[]
      /** The root of the project open on the Projects tab, if any. */
      project: string | null
      /** The issue whose ✕ was pressed once and now asks to confirm, if any. */
      deleting: number | null
      /** Per open group, the first card it shows: each group scrolls on its own, under its heading. */
      scrolled: Partial<Record<Priority, number>>
      /** The time a card's age is told from, `$.clock.now()` as read once each minute turned. */
      minute: number
    }
  }
}
