#!/usr/bin/env python3
import json, sys
d = json.load(open(sys.argv[1]))
binding_name = sys.argv[2]
expected_bucket = sys.argv[3]
prod = d.get('result', {}).get('deployment_configs', {}).get('production', {}) or {}
r2 = prod.get('r2_buckets') or {}
if binding_name in r2 and r2[binding_name].get('name') == expected_bucket:
    print(f'✓ {binding_name} bound to {expected_bucket}')
    sys.exit(0)
print(f'✗ {binding_name} NOT bound (found: {list(r2.keys())})')
sys.exit(1)
