# clipcmd Bash hook
# This file is managed by clipcmd. Do not edit manually.
#
# Sends /start before each command line runs and /end when it finishes, then
# prints the daemon's OSC 8 copy buttons. Every daemon call is silent and
# bounded by a short timeout, so a missing or dead daemon never breaks the shell.

# Directory holding the daemon's port file
if [[ -n "${CLIPCMD_CONFIG_DIR:-}" ]]; then
  _clipcmd_dir="${CLIPCMD_CONFIG_DIR//\\//}"
elif [[ -n "${USERPROFILE:-}" && ( "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ) ]]; then
  # Windows Git Bash / Cygwin: the daemon uses %USERPROFILE%, which may differ from $HOME
  _clipcmd_dir="${USERPROFILE//\\//}/.config/clipcmd"
else
  _clipcmd_dir="$HOME/.config/clipcmd"
fi
_clipcmd_port_file="$_clipcmd_dir/port"

# `clipcmd shell` sets CLIPCMD_SESSION; it captures this session's output
_clipcmd_session="${CLIPCMD_SESSION:-$$}"
if [[ -z "${CLIPCMD_SESSION:-}" && -r "/proc/$$/winpid" ]]; then
  # Git Bash / Cygwin: use the Windows pid, which is what VS Code reports
  IFS= read -r _clipcmd_session < "/proc/$$/winpid" 2>/dev/null || _clipcmd_session=$$
fi
_clipcmd_term=""
[[ "${TERM_PROGRAM:-}" == vscode ]] && _clipcmd_term=vscode

_clipcmd_ready=0      # 1 while waiting at the prompt: the next DEBUG trap is a user command
_clipcmd_started=0    # 1 after /start was sent for the running command
_clipcmd_seq=0        # command counter; ties `clipcmd shell` output to the command
_clipcmd_retry_at=0   # $SECONDS before which the daemon is assumed unreachable
_clipcmd_port=""

# Sets _clipcmd_port; fails if the daemon is not registered or recently unreachable.
# Uses only builtins: forking on every prompt is slow, especially under Git Bash.
_clipcmd_read_port() {
  (( SECONDS >= _clipcmd_retry_at )) || return 1
  [[ -r "$_clipcmd_port_file" ]] || return 1
  local line=""
  IFS= read -r line < "$_clipcmd_port_file" 2>/dev/null
  line="${line%%:*}"
  line="${line%$'\r'}"
  [[ "$line" =~ ^[0-9]+$ ]] || return 1
  _clipcmd_port="$line"
}

# curl exit 7 (connection refused) / 28 (timeout): back off for 30s instead of
# delaying every command by the timeout.
_clipcmd_note_curl_status() {
  case "$1" in
    7|28) _clipcmd_retry_at=$(( SECONDS + 30 )) ;;
  esac
}

# Percent-encodes $1 byte by byte into _clipcmd_enc, using builtins only.
# (Not curl --data-urlencode: under Git Bash, native curl.exe receives its
# arguments re-encoded in the Windows ANSI code page, corrupting non-ASCII text.)
_clipcmd_urlencode() {
  local LC_ALL=C s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  _clipcmd_enc="$out"
}

# Invisible marker telling `clipcmd shell` where a command's output starts or ends
_clipcmd_mark() {
  [[ -n "${CLIPCMD_SESSION:-}" ]] && printf '\033]9999;clipcmd;%s;%s\007' "$1" "$_clipcmd_seq" >&2
  return 0
}

# $1: the full command line
_clipcmd_send_start() {
  _clipcmd_read_port || return 0
  local query
  _clipcmd_seq=$(( _clipcmd_seq + 1 ))
  _clipcmd_urlencode "$1"; query="cmd=$_clipcmd_enc"
  _clipcmd_urlencode "$PWD"; query+="&pwd=$_clipcmd_enc"
  _clipcmd_urlencode "$_clipcmd_session"; query+="&sid=$_clipcmd_enc&seq=$_clipcmd_seq"
  [[ -n "$_clipcmd_term" ]] && query+="&term=$_clipcmd_term"
  curl --silent --max-time 1 --connect-timeout 0.5 --output /dev/null \
    "http://127.0.0.1:${_clipcmd_port}/start?${query}" 2>/dev/null
  local status=$?
  _clipcmd_note_curl_status "$status"
  if (( status == 0 )); then
    _clipcmd_started=1
    _clipcmd_mark start
  fi
  return 0
}

# $1: the command's exit code
_clipcmd_send_end() {
  (( _clipcmd_started )) || return 0
  _clipcmd_started=0
  _clipcmd_mark end
  _clipcmd_read_port || return 0
  local buttons
  _clipcmd_urlencode "$_clipcmd_session"
  buttons="$(curl --silent --fail --max-time 1 --connect-timeout 0.5 \
    "http://127.0.0.1:${_clipcmd_port}/end?exitCode=${1}&sid=${_clipcmd_enc}" 2>/dev/null)"
  _clipcmd_note_curl_status "$?"
  if [[ -n "$buttons" ]]; then
    printf '%s\n' "$buttons" >&2
  fi
  return 0
}

# Returns the full command line being executed. BASH_COMMAND only holds the
# current simple command (`ls` for `ls | grep x`), so prefer the history entry
# when it belongs to this command. It doesn't when HISTCONTROL skipped it
# (ignorespace): then the entry is stale and BASH_COMMAND is the fallback.
_clipcmd_last_hist=""
_clipcmd_command_line() {
  local cmd="$BASH_COMMAND" hist num text
  hist="$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)"
  if [[ "$hist" =~ ^[[:space:]]*([0-9]+)[*[:space:]][[:space:]](.*)$ ]]; then
    num="${BASH_REMATCH[1]}"
    text="${BASH_REMATCH[2]}"
    if [[ "$num" != "$_clipcmd_last_hist" || "$text" == *"$cmd"* ]]; then
      cmd="$text"
    fi
    _clipcmd_last_hist="$num"
  fi
  _clipcmd_cmdline="$cmd"
}

_clipcmd_preexec() {
  (( _clipcmd_ready )) || return 0
  [[ -n "${COMP_LINE:-}" ]] && return 0      # tab completion
  case "$BASH_COMMAND" in
    _clipcmd_*|__vsc_*|__bp_*) return 0 ;;    # prompt machinery (ours, VS Code, bash-preexec)
  esac
  [[ "$BASH_COMMAND" == "${PROMPT_COMMAND:-}" ]] && return 0
  _clipcmd_ready=0
  _clipcmd_command_line
  _clipcmd_send_start "$_clipcmd_cmdline"
}

# First entry of PROMPT_COMMAND, so $? is still the user command's status.
_clipcmd_precmd() {
  local exit_code=$?
  _clipcmd_ready=0
  _clipcmd_send_end "$exit_code"
  return "$exit_code"   # keep $? intact for later PROMPT_COMMAND entries and PS1
}

# Last entry of PROMPT_COMMAND: from here on, DEBUG traps are user commands.
_clipcmd_arm() {
  _clipcmd_ready=1
  if [[ -z "$_clipcmd_last_hist" ]]; then
    local hist
    hist="$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)"
    [[ "$hist" =~ ^[[:space:]]*([0-9]+) ]] && _clipcmd_last_hist="${BASH_REMATCH[1]}"
    [[ -z "$_clipcmd_last_hist" ]] && _clipcmd_last_hist="none"
  fi
}

_clipcmd_return() { return "$1"; }

# DEBUG trap entry point; runs any DEBUG trap that existed before clipcmd.
_clipcmd_debug_trap() {
  local status=$? last_arg="$1"
  case "$BASH_COMMAND" in
    # Our PROMPT_COMMAND entries are plumbing, not commands: hide them from
    # chained traps too, or e.g. VS Code would mark `_clipcmd_arm` as a command start.
    _clipcmd_precmd|_clipcmd_arm)
      _clipcmd_return "$status" "$last_arg"
      return
      ;;
  esac
  _clipcmd_preexec
  if [[ -n "${_clipcmd_prev_debug_trap:-}" ]]; then
    _clipcmd_return "$status" "$last_arg"   # restore $? and $_ for the chained trap
    eval "$_clipcmd_prev_debug_trap"
  fi
  _clipcmd_return "$status" "$last_arg"
}

# bash-preexec integration: its preexec gets the command line in $1 and
# precmd runs with $? set to the command's status.
_clipcmd_bp_preexec() { _clipcmd_send_start "$1"; }
_clipcmd_bp_precmd() { _clipcmd_send_end "$?"; }

# Install once per shell; re-sourcing ~/.bashrc just refreshes the functions above.
#
# This must run at the top level of ~/.bashrc, not inside a function: bash
# hides the DEBUG trap from `trap -p` inside functions (and while a file is
# being `source`d), so an existing trap could not be chained. VS Code's shell
# integration sources ~/.bashrc *before* setting its own DEBUG trap and then
# chains ours, so installing here keeps both working.
if [[ $- == *i* && -z "${_clipcmd_installed:-}" ]]; then
  _clipcmd_installed=1

  if [[ -n "${bash_preexec_imported:-}${__bp_imported:-}" ]]; then
    preexec_functions+=(_clipcmd_bp_preexec)
    precmd_functions+=(_clipcmd_bp_precmd)
  else
    _clipcmd_prev_debug_trap="$(trap -p DEBUG)"
    _clipcmd_prev_debug_trap="${_clipcmd_prev_debug_trap#trap -- \'}"
    _clipcmd_prev_debug_trap="${_clipcmd_prev_debug_trap%\' DEBUG}"
    _clipcmd_prev_debug_trap="${_clipcmd_prev_debug_trap//\'\\\'\'/\'}"
    if [[ -z "$_clipcmd_prev_debug_trap" ]]; then
      # `source ~/.bashrc` inside a VS Code terminal hides VS Code's trap from
      # us; chain its handler explicitly so its shell integration keeps working.
      if declare -F __vsc_preexec_all >/dev/null; then
        _clipcmd_prev_debug_trap='__vsc_preexec_all "$_"'
      elif declare -F __vsc_preexec_only >/dev/null; then
        _clipcmd_prev_debug_trap='__vsc_preexec_only "$_"'
      fi
    fi
    trap '_clipcmd_debug_trap "$_"' DEBUG

    # precmd first (so $? is the command's status), arm last
    if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
      PROMPT_COMMAND=(_clipcmd_precmd "${PROMPT_COMMAND[@]}" _clipcmd_arm)
    else
      PROMPT_COMMAND="_clipcmd_precmd${PROMPT_COMMAND:+
$PROMPT_COMMAND}
_clipcmd_arm"
    fi
  fi
fi
