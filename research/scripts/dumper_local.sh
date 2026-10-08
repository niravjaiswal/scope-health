#!/bin/sh
cd "/Users/nirav/development/scope health/agents/dumper" && SITE_URL=https://practice.speedrun.scopehealth.com SHIFT_SECONDS=${1:-60} CRAWL_FRAC=1 NPAGES=${2:-4} ../../.venv/bin/python dumper.py
