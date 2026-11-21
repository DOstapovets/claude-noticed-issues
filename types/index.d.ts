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
  /** That GitHub issue's status, as GitHub last reported it; once it is closed the issue is removed. */
  github?: GithubStatus
  /** When it was resolved, or closed on GitHub: set only on an issue kept on the Completed tab. */
  resolvedAt?: number
  /** The pull request for it: one that closes its GitHub issue, or one its session marked; absent until one is found. */
  pull?: Pull
}

/** A pull request as GitHub last reported it. */
export type Pull = {
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  /** Present, and true, only while it is a draft. */
  isDraft?: boolean
}

export type Priority = 'high' | 'medium' | 'low'

export type Tab = 'all' | 'session' | 'completed' | 'code' | 'projects' | 'settings'

/** What `$.store` keeps under `settings`, the same in every project. */
export type Settings = {
  /** Whether the experimental Code tab lists the comments in the code; absent is off. */
  todos?: boolean
  /** How many days a resolved issue stays on the Completed tab; absent is 7, 0 removes it at once. */
  keepDays?: number
}

/** A TODO, FIXME, HACK or XXX comment in the code, as `git grep` last found it: kept for the session only. */
export type Todo = {
  tag: 'TODO' | 'FIXME' | 'HACK' | 'XXX'
  /** Its path from the working tree's root. */
  file: string
  line: number
  /** What follows the tag, or, when nothing does, the tag and where it is. */
  text: string
}

export type GithubStatus = {
  state: 'OPEN' | 'CLOSED'
  /** Its Status column on the first project board that has one, e.g. `📋 To do`. */
  board?: string
}

/** What `$.store` keeps per repository, under `issues:<main working tree root>` (`issues:<cwd>` outside one). */
export type Stored = {
  nextId: number
  items: Issue[]
  /** The issues resolved within the last `keepDays` days, for the Completed tab; absent on lists from before 0.26. */
  done?: Issue[]
  /** The repository's `origin`, as the session that last changed the list saw it; absent outside a repository and on lists from before 0.22. */
  remote?: string
  /** When the list last changed; absent on lists from before 0.22. */
  updatedAt?: number
}

/** What `$.store` keeps per repository under `github:<root>`, shared by its sessions: when GitHub was last asked about its list, and until when it is not asked, as its rate limit ran low. */
export type GithubChecked = {
  checkedAt?: number
  pausedUntil?: number
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
    'noticely': {
      /** This project's open issues, mirrored from `$.store`. */
      issues: Issue[]
      /** This project's resolved issues still kept, mirrored from `$.store` (`done`). */
      completed: Issue[]
      /** The priority groups folded in the pane, mirrored from `$.store` (`collapsed`). */
      collapsed: Priority[]
      /** The pane's tab: every issue, only those this session noted, the resolved ones, the comments in the code, the other projects, or the settings. */
      tab: Tab
      /** The settings, mirrored from `$.store` (`settings`). */
      settings: Settings
      /** The TODO, FIXME, HACK and XXX comments in this working tree, as the last `git grep` found them. */
      todos: Todo[]
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
