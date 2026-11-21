# Changelog

## [0.26.0](https://github.com/DOstapovets/noticely/compare/v0.25.0...v0.26.0) (2026-11-21)


### Features

* a card shows its pull request, and GitHub is read in batches within its rate limit ([e215b5e](https://github.com/DOstapovets/noticely/commit/e215b5efbf3c433329d6958cef0e3d7d94c62a60))
* resolved issues stay on a Completed tab for the days chosen in Settings ([5a92f8d](https://github.com/DOstapovets/noticely/commit/5a92f8d188ccdf3b28dab29612966b1122187103))


### Bug Fixes

* the settings state types as Settings, not claude-code's own ([6a7d22c](https://github.com/DOstapovets/noticely/commit/6a7d22c3876c05d0b2fdfc4a102dca9f180234a3))


### Performance Improvements

* reloads redraw only on change, and a long line of code is read once ([9f725b6](https://github.com/DOstapovets/noticely/commit/9f725b6d9e856d69ec6e98a830aee3961f8967f8))

## [0.25.0](https://github.com/DOstapovets/noticely/compare/v0.24.0...v0.25.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* /notifly is now /noticely, the plugin installs as noticely, and the tools are mcp__noticely__note_issue, mcp__noticely__resolve_issue and mcp__noticely__save_issue_rule.
* the code is no longer MIT; copying, modifying or redistributing it needs written permission.
* the plugin installs as notifly (`/plugin install notifly --marketplace DOstapovets/claude-noticed-issues`), the marketplace is named notifly, and the tools are mcp__notifly__note_issue, mcp__notifly__resolve_issue and mcp__notifly__save_issue_rule.
* /issues, /issues clear, /issues setup and /issues feedback are now /notifly, /notifly clear, /notifly setup and /notifly feedback.

### Features

* ⚙ Settings beside Feedback, where the Code tab is switched on as experimental ([9c3b021](https://github.com/DOstapovets/noticely/commit/9c3b021ac6817377144fa0e35560047dbeaaa9e5))
* a card's ⎘ Copy puts the issue on the clipboard to paste into a prompt ([f93431a](https://github.com/DOstapovets/noticely/commit/f93431aa2a165b25519196afbd61bd6d41e2824f))
* note_issue names near duplicates and adds to one with duplicateOf ([5898b60](https://github.com/DOstapovets/noticely/commit/5898b6016cb0db0b71b445ee48e9f25ff5223c78))
* the plugin id is notifly, and its lists come over from noticed-issues ([27bf787](https://github.com/DOstapovets/noticely/commit/27bf7878baa885d1b2dae7fe793a77566f8f0654))
* the plugin is called Noticely, not Notifly ([41d09e6](https://github.com/DOstapovets/noticely/commit/41d09e6e502868634f204eedce6e27afdc7ecf1a))
* the plugin is called Notifly, and /notifly replaces /issues ([512d617](https://github.com/DOstapovets/noticely/commit/512d617a75073851cf7bfefdac491604727d4a49))
* the projects on the Projects tab stand a blank row apart ([2609195](https://github.com/DOstapovets/noticely/commit/2609195ca09e0ff28cf5f7d434ae4f7251c84713))


### Bug Fixes

* ▶ starts no second session for an issue that already has one ([9ef0ec2](https://github.com/DOstapovets/noticely/commit/9ef0ec25e590e05f14dc71b9ea6d72840a83447c))
* a project with no issues left is dim in the Projects list, its name too ([6fa41dd](https://github.com/DOstapovets/noticely/commit/6fa41dd656f87521d478a30100a8a0f18a51aeaf))
* folding the old per-worktree lists keeps the remote and skips damaged entries ([35fcf3b](https://github.com/DOstapovets/noticely/commit/35fcf3bb98a9c2fceceee86a8ac64dec41d5ed6b))
* issues noted at the same moment each get a number of their own, and none is lost ([3e35547](https://github.com/DOstapovets/noticely/commit/3e35547cda0bf90a098fd15de4f0bfd00cd99150))
* on the list of projects the footer stays at the pane's bottom edge ([280aa74](https://github.com/DOstapovets/noticely/commit/280aa74b96f078d3c3fc73f373dc768d1c7677e4))
* the tool hooks match the tools under their new id, mcp__noticely__* ([c118399](https://github.com/DOstapovets/noticely/commit/c1183995fea2ff029d27f2e3a609749e3a36b63c))


### Miscellaneous Chores

* Notifly is proprietary: free to install and use, all other rights reserved ([25b2bfb](https://github.com/DOstapovets/noticely/commit/25b2bfbf984b94d557b04cd1d63405c98252e8b8))

## [0.24.0](https://github.com/DOstapovets/claude-noticed-issues/compare/v0.23.0...v0.24.0) (2026-11-07)


### Features

* a Code tab lists the TODO, FIXME, HACK and XXX comments in the code ([ef806d1](https://github.com/DOstapovets/claude-noticed-issues/commit/ef806d1888b99eeb66eff07b85b17553ab328874))
* Projects and Feedback move to a footer at the pane's bottom edge ([e533dd3](https://github.com/DOstapovets/claude-noticed-issues/commit/e533dd35c8cf08b1eab6fbdd3137bcc1d143c1f3))
* the footer's Projects has an icon, ⧉, and Feedback a space a side ([f10d898](https://github.com/DOstapovets/claude-noticed-issues/commit/f10d8982aec066bab7a21838304cf1c4725af263))


### Bug Fixes

* the Code tab skips a TODO or FIXME inside a string's quotes ([95f0c9e](https://github.com/DOstapovets/claude-noticed-issues/commit/95f0c9effe555ce0882eb04b243b3eb18ce414b0))

## [0.23.0](https://github.com/DOstapovets/claude-noticed-issues/compare/v0.22.0...v0.23.0) (2026-11-06)


### Features

* a first session in a repository offers to analyze it and write when to note an issue there ([02f5f9a](https://github.com/DOstapovets/claude-noticed-issues/commit/02f5f9a0856d58398c40e7a4098c40a697001c53))

## [0.22.0](https://github.com/DOstapovets/claude-noticed-issues/compare/v0.21.0...v0.22.0) (2026-11-06)


### Features

* a Projects tab lists the other projects with a list and opens one read only ([90f73f4](https://github.com/DOstapovets/claude-noticed-issues/commit/90f73f4a6e8760e772108114d89d1605ebd84032))
* in VS Code each project on the Projects tab is a card with its name as a dim chip ([6d0c80b](https://github.com/DOstapovets/claude-noticed-issues/commit/6d0c80bdb28c0f5d68b944a881aee6afab8d4a5c))
* the Projects tab lists this project first, marked as this project ([c5e8b88](https://github.com/DOstapovets/claude-noticed-issues/commit/c5e8b8864cf3f53c19e17da023ae8f71850c757e))
* the Projects tab stands at the right of the tabs' row, without a count, in a secondary color ([4f70459](https://github.com/DOstapovets/claude-noticed-issues/commit/4f70459f40b27a1271fc9e7566c662a936d68c33))


### Bug Fixes

* a card's detail is cut to three lines however its words wrap ([a289364](https://github.com/DOstapovets/claude-noticed-issues/commit/a2893642cbcd2079dddd54a656629018688f83a5))

## [0.21.0](https://github.com/DOstapovets/claude-noticed-issues/compare/v0.20.0...v0.21.0) (2026-11-06)


### Features

* Feedback tells its session where it was started from ([44a7176](https://github.com/DOstapovets/claude-noticed-issues/commit/44a7176b96c7d8086f8598e48774411282d51fb2))
* the pane fits VS Code, where groups flow, the pane scrolls and the arrows show ([83f5e38](https://github.com/DOstapovets/claude-noticed-issues/commit/83f5e384dd4b19676bf3aa55f6c08a16b06d1ee6))


### Bug Fixes

* ▶ stays guarded until the started session's id is saved ([d227a36](https://github.com/DOstapovets/claude-noticed-issues/commit/d227a36677324a3688b7c3564e7afe53f5d36d8a))
* a change from another session is no longer lost or its id reused ([4fae2cf](https://github.com/DOstapovets/claude-noticed-issues/commit/4fae2cf1ca43c1f3ea5fc2ddd025a5f5e4cb0db8))
* a second press of ▶ does not start a second session ([a83ce2c](https://github.com/DOstapovets/claude-noticed-issues/commit/a83ce2c5562df80e37b947ba939f937500515244))
* a very long note is cut so it cannot fill the store ([d93fb1d](https://github.com/DOstapovets/claude-noticed-issues/commit/d93fb1d1ff8376a8755e93637739490926ad0337))
* an odd answer from gh no longer stops GitHub statuses updating ([86336bd](https://github.com/DOstapovets/claude-noticed-issues/commit/86336bd37915fbe8c58c5dcff8196cb7f4008fb3))
