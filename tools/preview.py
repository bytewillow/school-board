#!/usr/bin/env python3
"""Isolated, synthetic UI preview. Standard library only; never opens real data/."""
import argparse
from datetime import date, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


def seed():
    app.init_db()
    with app.db() as conn:
        conn.executemany('INSERT INTO children (id,name) VALUES (?,?)', [(1, '小禾'), (2, '小满')])
    rows = [
        ('练习册第 10 页', '数学', 'homework', 1, -1),
        ('朗读课文，读给家人听', '语文', 'homework', 1, 0),
        ('英语单词听写', '英语', 'homework', 1, 1),
        ('整理错题本', '数学', 'homework', 1, None),
        ('口算练习 20 题', '数学', 'homework', 2, 0),
        ('画一张秋天的图画', '语文', 'homework', 2, 2),
        ('周五带水壶和运动鞋', '其他', 'announcement', 0, None),
        ('一起阅读 15 分钟', '语文', 'homework', 0, 0),
        ('听力练习说明', '英语', 'notice', 1, None),
    ]
    for title, subject, kind, child, delta in rows:
        app.create_item({'title': title, 'subject': subject, 'kind': kind, 'child_id': str(child),
                         'due': (date.today() + timedelta(days=delta)).isoformat() if delta is not None else '',
                         'pinned': '1' if kind == 'announcement' else '',
                         'body': '这是用于界面预览的虚构示例，不是真实学生资料。'}, None, '')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='school-board-preview-') as directory:
        app.DATA_DIR = directory
        app.UPLOAD_DIR = str(Path(directory) / 'uploads')
        app.DB_PATH = str(Path(directory) / 'board.db')
        # No real model calls, API credentials or deployment settings in a preview.
        app.API_TOKEN = app.LLM_API_KEY = ''
        app.ADMIN_PASSWORD = 'preview-only-not-for-deployment'
        seed()
        original_page = app.page
        def preview_page(title, body):
            banner = ("<aside style='padding:8px 12px;margin:0 0 10px;border:1px dashed #a8b6c6;"
                      "border-radius:10px;font-size:13px;color:#526477'>界面预览 · 全部为虚构示例数据</aside>")
            return original_page(title, banner + body)
        app.page = preview_page
        with ThreadingHTTPServer(('127.0.0.1', args.port), app.Handler) as server:
            print(f'Preview: http://127.0.0.1:{args.port}/ (synthetic data; Ctrl+C to stop)', flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    main()
