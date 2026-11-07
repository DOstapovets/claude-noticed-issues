# Changelog

## [0.24.1](https://github.com/DOstapovets/claude-noticed-issues/compare/v0.24.0...v0.24.1) (2026-11-07)


### Bug Fixes

* on the list of projects the footer stays at the pane's bottom edge ([280aa74](https://github.com/DOstapovets/claude-noticed-issues/commit/280aa74b96f078d3c3fc73f373dc768d1c7677e4))

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
