#!/usr/bin/env bash
# Atlas Prime Sprint 6: initialize the DGM bare repo + worktree directory.
# Idempotent.

set -e
mkdir -p data/dgm.git data/dgm-worktrees
if [ ! -d data/dgm.git/refs ]; then
  git init --bare data/dgm.git
  cd data/dgm.git
  git config user.email "atlas-dgm@atlas.local"
  git config user.name "atlas-dgm"
  TREE=$(git mktree </dev/null)
  COMMIT=$(echo "init" | git commit-tree "$TREE")
  git branch master "$COMMIT"
  echo "dgm repo initialized at data/dgm.git"
else
  echo "dgm repo already exists at data/dgm.git (idempotent skip)"
fi
