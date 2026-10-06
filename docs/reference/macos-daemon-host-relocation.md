# macOS terminal daemon host relocation

Auto-update replaces the installed app while terminal daemons can remain alive for days.
On affected Macs, the surviving shells lose access to Documents, Desktop, or Downloads.
Retaining a resolvable executable alone does not establish the TCC permission subject:
the process responsible for those shells must also survive the replacement.

## Launch and runtime ownership

Packaged macOS Electron launches now copy the entire running `.app` to a private generation
under `userData/daemon-host-mac/<uuid>/`. Both Electron's actual Helper executable and the
unpacked daemon entry run from that copy. Framework symlinks, native modules, node-pty's
spawn-helper, resources, and the signature travel together. Development builds, plain-Node
hosts, Linux, and the existing Windows relocation path keep their existing launch strategy.

`/bin/cp -c -R -p -P` requests APFS cloning, preserves metadata and symlinks, and is bounded
by a 20-second copy deadline and a separate 10-second signature deadline.
**`-c` can perform a full copy**, particularly on non-APFS or across
volumes. Diagnostics explicitly describe the operation as a clone request with possible
full-copy fallback; storage sharing is not guaranteed. Each generation can therefore cost
the full bundle size. No hardlinks, quarantine removal, or re-signing are used. A deep,
strict signature verification must pass before publication. The source bundle and runtime paths
are resolved before cloning, including launches through a symlinked `.app`. An unsigned or damaged source
fails open to the installed runtime. Metadata lives beside the sealed `.app`.

A temporary property list bootstraps a unique job in the GUI user's `launchd` domain. It
uses `RunAtLoad` once, `KeepAlive=false`, and no demand sources. Nothing is installed in
`Library/LaunchAgents`, and daemon self-retirement does not trigger a respawn. Main can exit
while the daemon and terminals continue. `AbandonProcessGroup` retains the existing crash
survival behavior for terminal children. This GUI-domain strategy is unavailable without a
GUI login session. A launch failure falls back only after the owned process positively exits.
If its lifetime is unverifiable, daemon initialization declines to race another fork against it.

Only `ELECTRON_RUN_AS_NODE` enters the job's environment dictionary. PTY spawning still uses
exactly the inherited user environment as its baseline: a private 0600 startup file transfers
that snapshot, and a Node preload unlinks it before any daemon modules load. The launcher
also removes an unconsumed payload on completion or failure. Values never enter plist/argv;
the preload remains outside the signature seal. A crashed main before consumption can leave
a private payload in an uncertain, retained generation. Job inspection has a bounded 256 KiB
capture to accommodate launchd's own environment and diagnostic output.

The logical `entryPath` still describes the installed build for freshness checks. On this
launch path, the existing `spawnerExecPath` field records the clone Helper's stable
responsibility path. Old forked daemons keep their original metadata. This makes existing
attribution readers and #21826's installed-bundle comparison accept the intentional clone.
`isOwnedMacDaemonExecutable` also provides the shared location predicate for code-identity
classifiers, including a profile path whose name happens to contain `ShipIt`.

## Reservation, readiness, and retirement

Every attempt gets an immutable UUID generation, independent of app version, architecture,
channel, or another profile's concurrent launch. A complete generation record is published
before `launchd` can assess or start the executable. Nothing repairs or overwrites
that published generation; probes borrow it under a lock without changing the sealed app. An interrupted copy can remove only its unpublished staging tree.

Readiness authenticates the existing daemon endpoint and requires the expected launch nonce
and the PID reported by the attempt's exact launchd job. The connected client pair passes
directly into the adoption lease; there is no disconnect/reconnect gap. A different nonce or
the daemon's endpoint-occupied exit code adopts the winner through the existing launcher.
Only the daemon can publish or replace the canonical endpoint; the launcher never removes it.

Startup has a bounded assessment/readiness window. Failure removes only the attempt's unique
job after positive exit, then retries the installed-runtime fork, with a diagnostic. Successful
`bootout` alone is insufficient: it can return before process death. Shutdown first signals
that unique job, waits within a bounded budget for positive launchd exit evidence, and only
then removes it. An unverifiable lifetime retains the generation and withholds the fork.
A fallback never reports a protected launch.

Pruning ignores canonical PID files entirely. It needs a readable generation record, the
matching launchd target and executable, no current PID, and a recorded exit code or
terminating signal in the
exited job. A private retirement record saves this evidence before bootout and records successful
removal afterward, so later pruning can reclaim an already removed job. A corrupt or incomplete
record never authorizes deletion. A generation lock serializes probes and pruning across apps;
the lock stays held until the probe output is read and its process positively retires.
Running, delayed, missing, corrupt, timed-out, and otherwise unverifiable evidence retains
the host. Concurrent launches, old protocols, PID reuse, and separate profiles cannot remove
this reservation. Shutdown signals the specific job and waits for its exit, retaining its
job record as pruning evidence. There is no child-count reaper.

This intentionally prefers storage retention to breaking live terminals. Reboot, externally
removed jobs, interrupted bootstrap, or failed startup cleanup can leave generations without
positive exit evidence. They are retained; this PR does not add an absence-based sweeper.

## Permissions and recovery

TCC still decides whether the responsible code has access. In the macOS 27 ad-hoc packaged
measurement, TCC records the outer test app identifier as `AUTHREQ_SUBJECT`, including for
`SystemPolicyAllFiles`, while the cloned Helper is the independently responsible process.
The consent dialog names the outer app. The recovery action therefore reads the outer bundle
identifier from the actual daemon host; it does not reset the Helper identifier merely because
that process is responsible.

Measured-denial recovery (#21923) remains. Its folder read now prompts through a separate
one-shot launchd job using the actual daemon's existing immutable bundle. Focus refreshes
never clone or verify another full app and have a three-second overall deadline, including
bootstrap, polling, output, and cleanup. The explicit Fix allows sixty seconds for consent.
After the response deadline, bounded cleanup can continue with the generation still pinned.
An uncertain cleanup or crashed lock holder retains storage and returns unknown on later
probes. Actual forked daemons keep the existing probe/prompt path. Missing owned-host evidence
is unknown, never a guessed permission subject. Code identity remains diagnostic.

The same-build main-app Documents read succeeded before the launchd Helper's read. TCC then
rejected the stored code requirement for the Helper and raised another Documents prompt on
this ad-hoc build; granting the outer app alone did not carry over. An existing production Full Disk Access grant cannot be
promised to migrate from this evidence alone: a test FDA grant requires authentication, and
this host has no accessible administrator approval or Developer ID signing identity. Signed
release tests must check FDA on the outer app, FDA on the Helper, and managed path-based grants,
and record whether any new prompt occurs. Do not infer that all existing users will re-prompt
or that none will.

Existing daemons are authenticated and adopted before materialization. This preserves live
sessions from older builds; it cannot repair their removed code or change their existing
responsibility lineage. Users still need the measured recovery/restart path where appropriate.
No SSH execution state, remote wire, folder workspace assumptions, or agent-specific launch
behavior changes here.

## Validation contract

Unit suites cover host publication and failure, same-version/concurrent generations, job
reservations, positive pruning, authenticated readiness, endpoint races, fallback, and the
matching permission probe. Existing launch, adoption, attribution, and Windows relocation
suites must also pass.

Packaged proof must identify the actual responsible PID, resolve the mapped Helper with
`codesign --display +<pid>`, verify the complete clone signature, and measure protected-folder
enumeration and reads together. Keep the test app hidden and use a disposable profile. Never
replace the developer's installed app, stop its daemons, or change its grants. Replace only
the isolated original bundle; verify old shells and newly spawned children, then quit and
relaunch main and prove reattachment. A short success does not establish delayed TCC behavior.

An ad-hoc build and simulated bundle deletion do not prove signed/notarized Squirrel updates.
`.github/workflows/macos-updater-tests.yml` checks application-registry and update-quit logic,
not a real update or protected-folder survival. Signed A→B updates, supported macOS baselines,
x64, fresh-user/grant combinations, quarantine/translocation, sleep/wake, longer observation,
and representative security tooling remain release validation requirements. Folder success
alone makes no claim about Local Network permissions.

The upstream lab direction is documented in [PR #20452](https://github.com/stablyai/orca/pull/20452).
The independent code-identity detector in [PR #21826](https://github.com/stablyai/orca/pull/21826)
must continue recognizing intentional owned hosts when integrated.
