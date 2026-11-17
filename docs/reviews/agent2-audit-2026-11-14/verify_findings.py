"""Read-only воспроизведения: без настоящего .env, сети и записи в аккаунты."""
import ast
import csv
import io
import json
import os
from collections import Counter
from pathlib import Path
import re
import sys
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT))
from skills.direct_api import client

out = {}
# Воспроизведение окружения verifyDirectAccount, только фиктивные строки.
with patch.dict(os.environ, {client.TOKEN_ENV: 'FAKE_EXISTING', client.LEGACY_TOKEN_ENV: 'FAKE_SUBMITTED'}, clear=True):
    out['submitted_token_shadowed'] = client.build_headers()['Authorization'] == 'Bearer FAKE_EXISTING'
    with patch.object(client, '_transport_status', return_value=(200, 'headers\n')) as transport:
        client.get_report('2026-11-01', '2026-11-02')
        client.get_report('2026-11-01', '2026-11-02')
        names = [json.loads(c.args[0].data)['params']['ReportName'] for c in transport.call_args_list]
        out['default_report_name_changes_on_retry'] = names[0] != names[1]

# Исполняем только участок соединения двух уже полученных таблиц, без сетевого top-level.
p = PROJECT / 'docs/analytics/doma-karkas-2026-11-11/collect_audit.py'
source = p.read_text(encoding='utf-8')
start, end = source.index('rows = []'), source.index('md: list[str]')
ns = {'cabinet': {'A': {'name': 'known', 'spend': 100, 'clicks': 1, 'conv': 1, 'cpa': 100}},
      'metrika': {'A': {'visits': 10, 'Заказ оплачен': 1}, 'B': {'visits': 10, 'Заказ оплачен': 1}}}
exec(compile(source[start:end], str(p), 'exec'), ns)
out['join_counterexample'] = {'known_spend': 100, 'matched_paid': 1, 'reported_paid': ns['total']['paid'],
                              'correct_proxy_cost': 100, 'reported_proxy_cost': 100 / ns['total']['paid']}
ns = {'cabinet': {'A': {'name': 'missing', 'spend': 100, 'clicks': 1, 'conv': 1, 'cpa': 100}}, 'metrika': {}}
exec(compile(source[start:end], str(p), 'exec'), ns)
out['missing_join_becomes_zero_paid'] = ns['rows'][0]['paid'] == 0

root = PROJECT / 'docs/analytics/doma-karkas-2026-11-11'
checklist = (root / 'checklist-status-105.md').read_text(encoding='utf-8')
statuses = re.findall(r'^\|\s*\d+\s*\|[^\n]*?\|\s*(OK|НЕТ|ЧАСТ|ПРОБ|Н/П)\s*\|', checklist, re.M)
out['actual_checklist_counts'] = dict(Counter(statuses))
out['actual_checklist_total'] = len(statuses)
# Только сохранённые Reports, суммы в микроединицах.
raw = (root / 'direct-report-campaigns.tsv').read_text(encoding='utf-8').splitlines()
i = next(i for i, line in enumerate(raw) if line.startswith('CampaignId\t'))
rows = list(csv.DictReader(io.StringIO('\n'.join(raw[i:])), delimiter='\t'))
rows = [r for r in rows if str(r.get('CampaignId', '')).isdigit()]
out['campaign_report_actual_rows'] = len(rows)
out['campaign_report_cost_rub'] = round(sum(float(r['Cost']) / 1_000_000 for r in rows), 2)
out['campaign_report_unique_ids'] = len({r['CampaignId'] for r in rows})
# Паттерн *.local не покрывает *.local.json.
import fnmatch
out['local_json_matches_ignore_local'] = fnmatch.fnmatch('direct-accounts.local.json', '*.local')
print(json.dumps(out, ensure_ascii=False, indent=2))
