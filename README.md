# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mangkarones3-afk/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mangkarones3-afk/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

A launch-day Twitch viewership forecaster built on the comparable launches each case carries. Every past launch in the case file is re-indexed to event time and classified by its unlock pattern (rolling, global, early); the forecast for hours 2–24 is the target's hour-1 print carried along a similarity-weighted median of the comparables' log-ratio curves — weighted by unlock-class match and by scale similarity, the decisive term — with the five quantile levels (q05–q95) read from the cross-comparable dispersion at each hour, shrunk toward a smooth spread curve. Every fitted constant was calibrated by leave-one-out over the comparable library alone (each launch in turn forecast from the others, scored with the competition's pinball loss on the log scale): leave-one-out loss 0.269 against the house persistence baseline's 0.393 on the same protocol, and 0.219 against 0.387 on the four practice cases run end-to-end with no constant fitted on them. Any degenerate case (empty library, missing anchor, malformed comparable) falls back per-case to the persistence baseline, so the program always emits a valid forecast. Node 22, standard library only, offline, deterministic — repeated runs are byte-identical.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ram1fzcx&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
