#!/bin/bash
# Loads the image of the command line into the local Docker engine:
#   arena-public/cli:0.1.0
set -euo pipefail
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
docker load --input "$kit/images/arena-public-0.1.0.tar.gz"
