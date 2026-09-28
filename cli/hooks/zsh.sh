# clipcmd Zsh hook
# This file is managed by clipcmd. Do not edit manually.
#
# Sends /start before each command line runs and /end when it finishes, then
# prints the daemon's OSC 8 copy buttons. Every daemon call is silent and
# bounded by a short timeout, so a missing or dead daemon never breaks the shell.

if [[ -n "${CLIPCMD_CONFIG_DIR:-}" ]]; then
  _clipcmd_dir="$CLIPCMD_CONFIG_DIR"
else
  _clipcmd_dir="$HOME/.config/clipcmd"
fi
_clipcmd_port_file="$_clipcmd_dir/port"

# `clipcmd shell` sets CLIPCMD_SESSION; it captures this session's output
_clipcmd_session="${CLIPCMD_SESSION:-$$}"
_clipcmd_term=""
[[ "${TERM_PROGRAM:-}" == vscode ]] && _clipcmd_term=vscode

typeset -gi _clipcmd_started=0    # 1 after /start was sent for the running command
typeset -gi _clipcmd_seq=0        # command counter; ties `clipcmd shell` output to the command
typeset -gi _clipcmd_retry_at=0   # $SECONDS before which the daemon is assumed unreachable
typeset -g _clipcmd_port=""

# Sets _clipcmd_port; fails if the daemon is not registered or recently unreachable.
_clipcmd_read_port() {
  (( SECONDS >= _clipcmd_retry_at )) || return 1
  [[ -r "$_clipcmd_port_file" ]] || return 1
  local line=""
  IFS= read -r line < "$_clipcmd_port_file" 2>/dev/null
  line="${line%%:*}"
  [[ "$line" == <-> ]] || return 1
  _clipcmd_port="$line"
}

# curl exit 7 (connection refused) / 28 (timeout): back off for 30s.
_clipcmd_note_curl_status() {
  case "$1" in
    7|28) _clipcmd_retry_at=$(( SECONDS + 30 )) ;;
  esac
}

# Invisible marker telling `clipcmd shell` where a command's output starts or ends
_clipcmd_mark() {
  [[ -n "${CLIPCMD_SESSION:-}" ]] && printf '\033]9999;clipcmd;%s;%s\007' "$1" "$_clipcmd_seq" >&2
  return 0
}

# preexec: $1 is the command line as typed (empty if history is disabled),
# $3 the full text about to run. Empty lines never reach preexec.
_clipcmd_preexec() {
  _clipcmd_read_port || return 0
  (( _clipcmd_seq++ ))
  local -a term_args
  [[ -n "$_clipcmd_term" ]] && term_args=(--data-urlencode "term=$_clipcmd_term")
  curl --silent --max-time 1 --connect-timeout 0.5 --output /dev/null --get \
    --data-urlencode "cmd=${1:-$3}" \
    --data-urlencode "pwd=$PWD" \
    --data-urlencode "sid=$_clipcmd_session" \
    --data-urlencode "seq=$_clipcmd_seq" \
    "${term_args[@]}" \
    "http://127.0.0.1:${_clipcmd_port}/start" 2>/dev/null
  local exit_status=$?
  _clipcmd_note_curl_status $exit_status
  if (( exit_status == 0 )); then
    _clipcmd_started=1
    _clipcmd_mark start
  fi
  return 0
}

_clipcmd_precmd() {
  local exit_code=$?
  (( _clipcmd_started )) || return 0
  _clipcmd_started=0
  _clipcmd_mark end
  _clipcmd_read_port || return 0

  # Capture response body: daemon returns OSC 8 button string in body
  local buttons
  buttons="$(curl --silent --fail --max-time 1 --connect-timeout 0.5 --get \
    --data-urlencode "exitCode=$exit_code" \
    --data-urlencode "sid=$_clipcmd_session" \
    "http://127.0.0.1:${_clipcmd_port}/end" 2>/dev/null)"
  _clipcmd_note_curl_status $?

  if [[ -n "$buttons" ]]; then
    print -r -- "$buttons" >&2
  fi
  return 0
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _clipcmd_preexec
# Run first among precmd hooks so $? is the command's status, not another hook's.
precmd_functions=(_clipcmd_precmd ${precmd_functions:#_clipcmd_precmd})
