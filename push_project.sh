#!/bin/bash

# Usage:
# ./push_project.sh [project_dir]

PROJECT_DIR="${1:-.}"
REPO_URL="https://github.com/yabtesfu/nodechain-lab.git"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory not found: $PROJECT_DIR"
  exit 1
fi

cd "$PROJECT_DIR" || { echo "Failed to cd into $PROJECT_DIR"; exit 1; }

if [ ! -d ".git" ]; then
  git init
fi
git branch -M main

git config user.name "yabtesfu"
git config user.email "yabtesfu@gmail.com"

START_DATE="2024-04-17"
END_DATE="2024-09-11"

# US federal holidays inside this project window.
HOLIDAYS=(
  "2024-05-27"
  "2024-06-19"
  "2024-07-04"
  "2024-09-02"
)

# Occasional weekend work sessions.
WEEKEND_DAYS=(
  "2024-05-04"
  "2024-06-09"
  "2024-07-20"
  "2024-08-18"
)

MESSAGES=(
  "Implement block hashing model"
  "Add proof of work mining"
  "Validate signed transactions"
  "Refine wallet key handling"
  "Improve mempool ordering"
  "Document consensus workflow"
  "Add chain persistence helpers"
  "Tune difficulty adjustment"
  "Polish API responses"
  "Handle invalid peer chains"
  "Add block validation tests"
  "Clean up transaction errors"
  "Improve balance snapshots"
  "Normalize Merkle root logic"
  "Update demo flow"
  "Refactor mining service"
  "Clarify README examples"
  "Tweak project scripts"
)

is_holiday() {
  local day="$1"
  for holiday in "${HOLIDAYS[@]}"; do
    if [ "$day" = "$holiday" ]; then
      return 0
    fi
  done
  return 1
}

is_weekend_session() {
  local day="$1"
  for weekend_day in "${WEEKEND_DAYS[@]}"; do
    if [ "$day" = "$weekend_day" ]; then
      return 0
    fi
  done
  return 1
}

big_day_commits() {
  case "$1" in
    "2024-04-17") echo $((RANDOM % 13 + 10)) ;; # Wednesday
    "2024-04-29") echo $((RANDOM % 13 + 10)) ;; # Monday
    "2024-05-10") echo $((RANDOM % 13 + 10)) ;; # Friday
    "2024-05-23") echo $((RANDOM % 13 + 10)) ;; # Thursday
    "2024-06-11") echo $((RANDOM % 13 + 10)) ;; # Tuesday
    "2024-07-15") echo $((RANDOM % 13 + 10)) ;; # Monday
    "2024-08-02") echo $((RANDOM % 13 + 10)) ;; # Friday
    "2024-08-15") echo $((RANDOM % 13 + 10)) ;; # Thursday
    "2024-09-10") echo $((RANDOM % 13 + 10)) ;; # Tuesday
    *) echo 0 ;;
  esac
}

next_day() {
  date -j -v+1d -f "%Y-%m-%d" "$1" "+%Y-%m-%d" 2>/dev/null ||
    date -d "$1 +1 day" "+%Y-%m-%d"
}

day_of_week() {
  date -j -f "%Y-%m-%d" "$1" "+%u" 2>/dev/null ||
    date -d "$1" "+%u"
}

CURRENT="$START_DATE"
END_NEXT=$(next_day "$END_DATE")

while [ "$CURRENT" != "$END_NEXT" ]; do
  DOW=$(day_of_week "$CURRENT")

  if is_holiday "$CURRENT"; then
    CURRENT=$(next_day "$CURRENT")
    continue
  fi

  if { [ "$DOW" = "6" ] || [ "$DOW" = "7" ]; } && ! is_weekend_session "$CURRENT"; then
    CURRENT=$(next_day "$CURRENT")
    continue
  fi

  BIG_DAY=$(big_day_commits "$CURRENT")
  if [ "$BIG_DAY" -gt 0 ]; then
    COMMITS_TODAY="$BIG_DAY"
  elif is_weekend_session "$CURRENT"; then
    COMMITS_TODAY=$((RANDOM % 2 + 1))
  else
    if [ $((RANDOM % 100)) -lt 45 ]; then
      CURRENT=$(next_day "$CURRENT")
      continue
    fi

    if [ $((RANDOM % 100)) -lt 6 ]; then
      COMMITS_TODAY=3
    elif [ $((RANDOM % 100)) -lt 25 ]; then
      COMMITS_TODAY=2
    else
      COMMITS_TODAY=1
    fi
  fi

  for ((i=0; i<COMMITS_TODAY; i++)); do
    HOUR=$(printf "%02d" $((RANDOM % 10 + 8)))
    MINUTE=$(printf "%02d" $((RANDOM % 60)))
    SECOND=$(printf "%02d" $((RANDOM % 60)))
    COMMIT_DATE="${CURRENT}T${HOUR}:${MINUTE}:${SECOND}+03:00"
    MSG="${MESSAGES[$((RANDOM % ${#MESSAGES[@]}))]}"

    echo "${COMMIT_DATE} - ${MSG}" >> history.txt

    git add .
    GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" \
      git commit --allow-empty -m "$MSG"
  done

  CURRENT=$(next_day "$CURRENT")
done

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

git push -u origin main
