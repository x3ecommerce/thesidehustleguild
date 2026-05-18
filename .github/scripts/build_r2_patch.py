#!/usr/bin/env python3
"""Build a PATCH payload that adds SUBMISSIONS_BUCKET binding to both deployment configs."""
import json, sys
src = sys.argv[1]
bucket_name = sys.argv[2]
binding_name = sys.argv[3]
out = sys.argv[4]
d = json.load(open(src))
configs = d['result']['deployment_configs'] or {}
for env_key in ('production', 'preview'):
    cfg = configs.setdefault(env_key, {})
    if cfg is None:
        cfg = {}
        configs[env_key] = cfg
    r2 = cfg.get('r2_buckets') or {}
    r2[binding_name] = {'name': bucket_name}
    cfg['r2_buckets'] = r2
with open(out, 'w') as f:
    json.dump({'deployment_configs': configs}, f)
print(f'Wrote patch to {out}')
