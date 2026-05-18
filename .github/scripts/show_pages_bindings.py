#!/usr/bin/env python3
"""Print summary of current Pages project bindings."""
import json, sys
d = json.load(open(sys.argv[1]))
prod = d.get('result', {}).get('deployment_configs', {}).get('production', {}) or {}
print('  D1:', list((prod.get('d1_databases') or {}).keys()))
print('  R2:', list((prod.get('r2_buckets') or {}).keys()))
print('  Vars:', list((prod.get('env_vars') or {}).keys()))
