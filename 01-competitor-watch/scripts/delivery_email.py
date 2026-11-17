#!/usr/bin/env python3
r"""delivery_email.py - send the weekly report by e-mail (task WP2).

Standard library only (smtplib + email).

Transport comes from 00-admin/config/settings.yaml -> delivery.email:
    smtp_host, smtp_port, smtp_user, from, use_ssl,
    smtp_password_env (default DSH_SMTP_PASSWORD), smtp_password_file,
    subject_template.
The password is NEVER stored inline in a config file: it is read from the
environment first, then from the local file smtp_password_file (a local secret,
excluded from publication — see .gitignore).

Recipients come from the agent's thin settings (delivery.addresses). When that
list has no e-mail address, the client config recipients (channel: email) are
used as a fallback.
They are then filtered by delivery.recipients_allowlist: since 04.11.2026 the
letters go to an explicit whitelist only, and any other address is dropped with
a warning (the user's decision, changed only in settings.yaml).

Honest failure policy (the engine must never fail silently or crash):
    * no SMTP host/user/password  -> the finished letter is saved as a .eml file
      next to the report and the journal records
      «не отправлено: нет SMTP-доступа»;
    * SMTP error                  -> status "failed" with the reason, and the
      .eml is still saved so nothing is lost;
    * success                     -> status "sent".
Every recipient gets its own record: {to, status, sent_at, file, reason}.
"""
from __future__ import annotations

import datetime as _dt
import os
import smtplib
import sys
from email.message import EmailMessage
from pathlib import Path

import cwlib as cw

STATUS_SENT = "sent"
STATUS_EML_SAVED = "eml_saved"
STATUS_FAILED = "failed"
NO_SMTP_REASON = "не отправлено: нет SMTP-доступа"
DEFAULT_PASSWORD_ENV = "DSH_SMTP_PASSWORD"
DEFAULT_SUBJECT = "Конкуренты, неделя {date_from}–{date_to}"
EMAIL_CHANNEL = "email"

# Режимы отправки (контракт v2, §5.4). Дефолт — никогда: ad-hoc прогон и
# сохранение настроек не рассылают ничего.
EMAIL_MODES = ("never", "always", "on-request")
DEFAULT_EMAIL_MODE = "never"
# Единая причина отказа сухого прогона (D-DRY): --dry-run не шлёт письма ни в
# одном режиме и всегда объясняет это одними словами.
DRY_RUN_REASON = "сухой прогон: письмо не отправлено"


def delivery_channels(agent_settings=None):
    """delivery.channels из тонких настроек агента в нижнем регистре."""
    node = (agent_settings or {}).get("delivery") if isinstance(agent_settings, dict) else {}
    raw = node.get("channels") if isinstance(node, dict) else None
    if isinstance(raw, str):
        raw = [raw]
    return [str(item).strip().lower() for item in raw or [] if str(item or "").strip()]


def email_allowed(mode, agent_settings=None):
    """(отправлять, причина отказа словами) ровно по §5.4.

    Письмо уходит, только если одновременно: режим `always`/`on-request`,
    `delivery.channels` содержит email и (для `always`) `delivery.auto_send: true`.
    Любой отказ возвращает готовую фразу для панели и журнала.
    """
    mode = str(mode or DEFAULT_EMAIL_MODE).strip().lower()
    if mode not in EMAIL_MODES:
        return False, ("письмо не отправлено: неизвестный режим отправки «%s» "
                       "(ожидается never, always или on-request)" % mode)
    if mode == "never":
        return False, ("письмо не отправлено: режим отправки never — отчёт формируется, "
                       "но не рассылается")
    if EMAIL_CHANNEL not in delivery_channels(agent_settings):
        return False, "письмо не отправлено: канал email выключен"
    if mode == "always":
        node = (agent_settings or {}).get("delivery") if isinstance(agent_settings, dict) else {}
        auto_send = bool(node.get("auto_send")) if isinstance(node, dict) else False
        if not auto_send:
            return False, ("письмо не отправлено: автоотправка выключена — "
                           "нажмите «Отправить отчёт сейчас»")
    return True, None


def email_transport(config_dir=None, settings=None):
    """delivery.email block with the defaults the engine relies on."""
    if settings is None:
        settings = cw.load_settings(config_dir)
    node = (settings or {}).get("delivery")
    block = node.get("email") if isinstance(node, dict) else {}
    block = block if isinstance(block, dict) else {}
    return {
        "smtp_host": str(block.get("smtp_host") or "").strip(),
        "smtp_port": int(block.get("smtp_port") or 465),
        "smtp_user": str(block.get("smtp_user") or "").strip(),
        "sender": str(block.get("from") or "").strip(),
        "use_ssl": bool(block.get("use_ssl", True)),
        "password_env": str(block.get("smtp_password_env") or DEFAULT_PASSWORD_ENV).strip()
                        or DEFAULT_PASSWORD_ENV,
        "password_file": _password_file(block),
        "subject_template": str(block.get("subject_template") or DEFAULT_SUBJECT),
    }


def _password_file(block):
    """Absolute path to the local password file, or None when it is not configured."""
    value = str((block or {}).get("smtp_password_file") or "").strip()
    if not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else (cw.PROJECT_ROOT / path)


def smtp_password(transport, environ=None):
    """Password: environment variable first, then the local secret file."""
    environ = environ if environ is not None else os.environ
    env_name = (transport or {}).get("password_env") or DEFAULT_PASSWORD_ENV
    value = (environ.get(env_name) or "").strip()
    if value:
        return value
    path = (transport or {}).get("password_file")
    if path:
        try:
            text = Path(path).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
        return text.splitlines()[0].strip() if text else ""
    return ""


def recipients_allowlist(settings=None, config_dir=None):
    """Hard whitelist from settings.yaml -> delivery.recipients_allowlist.

    An empty/missing list means "no restriction" (the pre-04.11 behaviour); a
    non-empty list is enforced strictly.
    """
    if settings is None:
        settings = cw.load_settings(config_dir)
    node = (settings or {}).get("delivery") if isinstance(settings, dict) else {}
    raw = node.get("recipients_allowlist") if isinstance(node, dict) else None
    if isinstance(raw, str):
        raw = [raw]
    found = []
    for item in raw or []:
        address = str(item or "").strip().lower()
        if is_email(address) and address not in found:
            found.append(address)
    return found


def split_by_allowlist(recipients, allowlist):
    """(kept, rejected) — the whitelist decides who may receive the report."""
    if not allowlist:
        return list(recipients or []), []
    allowed = {str(item).strip().lower() for item in allowlist}
    kept, rejected = [], []
    for address in recipients or []:
        (kept if str(address).strip().lower() in allowed else rejected).append(address)
    return kept, rejected



def missing_reason(transport, password):
    """Human reason why the letter cannot be sent, or None when it can."""
    if not (transport or {}).get("smtp_host"):
        return "%s: в settings.yaml -> delivery.email не задан smtp_host" % NO_SMTP_REASON
    if not (transport or {}).get("smtp_user") and not (transport or {}).get("sender"):
        return "%s: не задан ни smtp_user, ни from" % NO_SMTP_REASON
    if not password:
        return "%s: не задан пароль в переменной %s" % (
            NO_SMTP_REASON, (transport or {}).get("password_env") or DEFAULT_PASSWORD_ENV)
    return None


def is_email(value):
    text = str(value or "").strip()
    return "@" in text and "." in text.rsplit("@", 1)[-1] and " " not in text


def recipients_from(agent_settings=None, client=None, allowlist=None, settings=None,
                    config_dir=None, warn=None):
    """E-mail addresses, in order: agent delivery.addresses, then client recipients.

    Every address is then filtered by delivery.recipients_allowlist from
    settings.yaml. Rejected addresses are reported honestly (stderr by default)
    and never receive the letter.
    """
    found = []
    node = (agent_settings or {}).get("delivery") if isinstance(agent_settings, dict) else {}
    addresses = node.get("addresses") if isinstance(node, dict) else None
    if isinstance(addresses, str):
        addresses = [addresses]
    for address in addresses or []:
        if is_email(address) and address not in found:
            found.append(str(address).strip())
    for item in (client or {}).get("recipients") or []:
        if isinstance(item, dict) and str(item.get("channel") or "").lower() == EMAIL_CHANNEL:
            address = str(item.get("address") or "").strip()
            if is_email(address) and address not in found:
                found.append(address)
    if allowlist is None:
        allowlist = recipients_allowlist(settings, config_dir)
    kept, rejected = split_by_allowlist(found, allowlist)
    if rejected:
        note = ("delivery: отброшены адреса вне белого списка "
                "settings.yaml -> delivery.recipients_allowlist: %s" % ", ".join(rejected))
        if warn is not None:
            warn(note)
        else:
            sys.stderr.write(note + "\n")
    return kept


def subject_for(transport, prev_date, curr_date):
    template = (transport or {}).get("subject_template") or DEFAULT_SUBJECT
    try:
        return template.format(date_from=prev_date or "нет", date_to=curr_date)
    except (KeyError, IndexError, ValueError):
        return DEFAULT_SUBJECT.format(date_from=prev_date or "нет", date_to=curr_date)


def build_message(subject, body, attachments, sender, to):
    """EmailMessage with the attachments; xlsx first, pdf added when it exists."""
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender or "competitor-watch@localhost"
    message["To"] = to
    message.set_content(body)
    for path in attachments or []:
        path = Path(path)
        if not path.exists():
            continue
        if path.suffix.lower() == ".pdf":
            maintype, subtype = "application", "pdf"
        elif path.suffix.lower() == ".xlsx":
            maintype = "application"
            subtype = "vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            maintype, subtype = "application", "octet-stream"
        message.add_attachment(path.read_bytes(), maintype=maintype, subtype=subtype,
                               filename=path.name)
    return message


def _attachment_plan(files):
    """xlsx + pdf when both exist, otherwise xlsx (per the task contract)."""
    files = files or {}
    plan = []
    xlsx = files.get("xlsx")
    pdf = files.get("pdf")
    if xlsx:
        plan.append(Path(xlsx))
    if pdf:
        plan.append(Path(pdf))
    return plan


def _write_eml(message, out_dir, date):
    path = Path(out_dir) / ("%s-competitor-watch.eml" % date)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(message.as_bytes())
    return path


def _write_journal(out_dir, date, records):
    path = Path(out_dir) / cw.CACHE_DIR_NAME / ("email-%s.json" % date)
    return cw.json_dump(path, {"date": date, "generated_at":
                               _dt.datetime.now().replace(microsecond=0).isoformat(),
                               "records": records})


def _body(prev_date, curr_date, client=None):
    name = (client or {}).get("name") or ""
    lines = ["Отчёт по конкурентам за %s — %s." % (prev_date or "нет", curr_date), ""]
    if name:
        lines.append("Клиент: %s." % name)
    lines += ["Отчёт во вложении: XLSX (и PDF, если он собран).",
              "Данные собраны с публичных страниц без входа в аккаунты; чего нет на странице — остаётся пустым.",
              "", "Письмо сформировано автоматически Агентом 1 (competitor-watch)."]
    return "\n".join(lines)


def deliver_report(files, recipients, out_dir, date, transport=None, password=None,
                   prev_date=None, curr_date=None, client=None, environ=None,
                   sender=None, dry_run=False):
    """Send the report to every recipient; always returns a per-address record list.

    Never raises: transport problems become statuses, and the finished letter is
    saved as .eml next to the report.
    """
    out_dir = Path(out_dir)
    transport = transport or email_transport()
    password = smtp_password(transport, environ) if password is None else password
    curr_date = curr_date or date
    subject = subject_for(transport, prev_date, curr_date)
    attachments = _attachment_plan(files)
    body = _body(prev_date, curr_date, client)
    records = []
    eml_path = None
    reason = missing_reason(transport, password)

    for address in recipients or []:
        record = {"to": address, "status": None, "sent_at": None, "file": None, "reason": None}
        if reason:
            if eml_path is None:
                message = build_message(subject, body, attachments,
                                        sender or transport.get("sender"), address)
                eml_path = _write_eml(message, out_dir, date)
            record.update(status=STATUS_EML_SAVED, file=str(eml_path), reason=reason)
            records.append(record)
            continue
        message = build_message(subject, body, attachments,
                                sender or transport.get("sender"), address)
        try:
            if dry_run:
                raise RuntimeError("dry-run: отправка не выполнялась")
            if transport.get("use_ssl", True):
                server = smtplib.SMTP_SSL(transport["smtp_host"], transport["smtp_port"], timeout=60)
            else:
                server = smtplib.SMTP(transport["smtp_host"], transport["smtp_port"], timeout=60)
                server.starttls()
            with server:
                if transport.get("smtp_user"):
                    server.login(transport["smtp_user"], password)
                server.send_message(message)
            record.update(status=STATUS_SENT,
                          sent_at=_dt.datetime.now().replace(microsecond=0).isoformat())
        except Exception as exc:                     # network, auth, TLS, dry-run
            if eml_path is None:
                eml_path = _write_eml(message, out_dir, date)
            record.update(status=STATUS_FAILED, file=str(eml_path),
                          reason="не отправлено: %s" % (exc,))
        records.append(record)

    if not recipients:
        records.append({"to": None, "status": STATUS_FAILED, "sent_at": None, "file": None,
                        "reason": "не отправлено: не задан ни один адрес получателя"})
    _write_journal(out_dir, date, records)
    return records


def journal_status(records):
    """Short human line for the run journal (data/source-runs.jsonl style)."""
    if not records:
        return "не отправлено: нет получателей"
    statuses = {record.get("status") for record in records}
    if statuses == {STATUS_SENT}:
        return "отправлено: %d адрес(ов)" % len(records)
    if STATUS_SENT in statuses:
        return "отправлено частично: %d из %d" % (
            sum(1 for r in records if r.get("status") == STATUS_SENT), len(records))
    for record in records:
        if record.get("status") == STATUS_EML_SAVED:
            return record.get("reason") or NO_SMTP_REASON
    return records[0].get("reason") or "не отправлено"
