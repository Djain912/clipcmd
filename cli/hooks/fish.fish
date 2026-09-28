# clipcmd Fish hook
# This file is managed by clipcmd. Do not edit manually.
#
# Sends /start before each command line runs and /end when it finishes, then
# prints the daemon's OSC 8 copy buttons. Every daemon call is silent and
# bounded by a short timeout, so a missing or dead daemon never breaks the shell.

if set -q CLIPCMD_CONFIG_DIR
    set -g _clipcmd_port_file "$CLIPCMD_CONFIG_DIR/port"
else
    set -g _clipcmd_port_file "$HOME/.config/clipcmd/port"
end

# `clipcmd shell` sets CLIPCMD_SESSION; it captures this session's output
set -g _clipcmd_session $fish_pid
set -q CLIPCMD_SESSION; and set -g _clipcmd_session $CLIPCMD_SESSION
set -g _clipcmd_term ''
test "$TERM_PROGRAM" = vscode; and set -g _clipcmd_term vscode

set -g _clipcmd_started 0
set -g _clipcmd_seq 0    # command counter; ties `clipcmd shell` output to the command
set -g _clipcmd_skip 0   # commands to skip after the daemon was unreachable
set -g _clipcmd_port ''

# Sets _clipcmd_port; fails if the daemon is not registered or recently unreachable.
function _clipcmd_read_port
    if test $_clipcmd_skip -gt 0
        set -g _clipcmd_skip (math $_clipcmd_skip - 1)
        return 1
    end
    test -r $_clipcmd_port_file; or return 1
    set -g _clipcmd_port (string replace -r ':.*$' '' < $_clipcmd_port_file 2>/dev/null)[1]
    string match -qr '^[0-9]+$' -- "$_clipcmd_port"
end

# curl exit 7 (connection refused) / 28 (timeout): skip the next 10 commands.
function _clipcmd_note_curl_status
    switch $argv[1]
        case 7 28
            set -g _clipcmd_skip 10
    end
end

# Invisible marker telling `clipcmd shell` where a command's output starts or ends
function _clipcmd_mark
    set -q CLIPCMD_SESSION; and printf '\e]9999;clipcmd;%s;%s\a' $argv[1] $_clipcmd_seq >&2
    return 0
end

function _clipcmd_preexec --on-event fish_preexec
    # argv[1] is the command line; fish never emits this for empty lines
    _clipcmd_read_port; or return 0
    set -g _clipcmd_seq (math $_clipcmd_seq + 1)
    set -l term_args
    test -n "$_clipcmd_term"; and set term_args --data-urlencode "term=$_clipcmd_term"
    curl --silent --max-time 1 --connect-timeout 0.5 --output /dev/null --get \
        --data-urlencode "cmd=$argv[1]" \
        --data-urlencode "pwd=$PWD" \
        --data-urlencode "sid=$_clipcmd_session" \
        --data-urlencode "seq=$_clipcmd_seq" \
        $term_args \
        "http://127.0.0.1:$_clipcmd_port/start" 2>/dev/null
    set -l curl_status $status
    _clipcmd_note_curl_status $curl_status
    if test $curl_status -eq 0
        set -g _clipcmd_started 1
        _clipcmd_mark start
    end
    return 0
end

function _clipcmd_postexec --on-event fish_postexec
    # The command's exit status is $status here; fish passes only the command line in argv
    set -l exit_code $status
    test "$_clipcmd_started" = 1; or return 0
    set -g _clipcmd_started 0
    _clipcmd_mark end
    _clipcmd_read_port; or return 0

    # The daemon returns the OSC 8 buttons in the response body
    set -l buttons (curl --silent --fail --max-time 1 --connect-timeout 0.5 --get \
        --data-urlencode "exitCode=$exit_code" \
        --data-urlencode "sid=$_clipcmd_session" \
        "http://127.0.0.1:$_clipcmd_port/end" 2>/dev/null)
    _clipcmd_note_curl_status $status

    if test -n "$buttons"
        printf '%s\n' $buttons >&2
    end
    return 0
end
