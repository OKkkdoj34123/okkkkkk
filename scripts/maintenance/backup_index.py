"""只取消本地备份的 Git 跟踪；工作区文件不删除。提供带冲突保护的恢复。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

PREFIXES = (b'patch_backups/', b'_patch_backups/')

def sha(data):
    return hashlib.sha256(data).hexdigest()

def git(root, *args, data=None, env=None):
    p = subprocess.run(['git', '-C', str(root), *args], input=data, capture_output=True, env=env)
    if p.returncode:
        raise RuntimeError(p.stderr.decode('utf-8', errors='replace').strip())
    return p.stdout

def inspect(root):
    try:
        top = git(root, 'rev-parse', '--show-toplevel').decode().strip()
    except (OSError, RuntimeError):
        return None
    if Path(top).resolve() != root.resolve():
        raise RuntimeError('请使用Git仓库根目录；不改父级或嵌套仓库索引。')
    if os.environ.get('GIT_INDEX_FILE'):
        raise RuntimeError('检测到外部GIT_INDEX_FILE，请在普通Git工作区执行。')
    shared = git(root, 'rev-parse', '--shared-index-path').strip()
    if shared:
        raise RuntimeError('当前使用split-index；本工具不自动改变该设置，请先处理Git索引模式。')
    p = Path(git(root, 'rev-parse', '--git-path', 'index').decode().strip())
    index = p if p.is_absolute() else root / p
    index = index.absolute()
    if index.is_symlink():
        raise RuntimeError('Git索引不能是符号链接。')
    entries = git(root, 'ls-files', '--stage', '-z').split(b'\0')
    selected = []
    for entry in entries:
        if not entry:
            continue
        header, name = entry.split(b'\t', 1)
        if name.startswith(PREFIXES):
            if header.split()[-1] != b'0':
                raise RuntimeError('备份路径存在未合并的索引条目，停止清理。')
            selected.append(name)
    return index, selected

def install_index(index, expected, replacement):
    lock = index.with_name(index.name + '.lock')
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(replacement); out.flush(); os.fsync(out.fileno())
        if index.read_bytes() != expected:
            raise RuntimeError('Git暂存区在检查后发生变化，停止覆盖。')
        os.chmod(lock, index.stat().st_mode & 0o777)
        os.replace(lock, index)
    finally:
        lock.unlink(missing_ok=True)

def apply(root, backup):
    found = inspect(root)
    if found is None:
        print('未检测到Git仓库：保留忽略规则，未执行索引清理。')
        return
    index, selected = found
    if not selected:
        print('Git未跟踪本地备份，无需清理。')
        return
    before = index.read_bytes()
    fd, temp = tempfile.mkstemp(prefix='maintenance-index-', dir=str(index.parent))
    os.close(fd)
    try:
        Path(temp).write_bytes(before)
        env = os.environ.copy(); env['GIT_INDEX_FILE'] = temp
        git(root, 'update-index', '--force-remove', '-z', '--stdin', data=b'\0'.join(selected) + b'\0', env=env)
        after = Path(temp).read_bytes()
        # Independently prove every non-backup index entry is unchanged.
        prior_entries = git(root, 'ls-files', '--stage', '-z').split(b'\0')
        expected_entries = [e for e in prior_entries if e and not e.split(b'\t', 1)[1].startswith(PREFIXES)]
        actual_entries = [e for e in git(root, 'ls-files', '--stage', '-z', env=env).split(b'\0') if e]
        if expected_entries != actual_entries:
            raise RuntimeError('索引变化超出备份目录，停止。')
        backup.mkdir(parents=True, exist_ok=False)
        (backup / 'index.before').write_bytes(before)
        (backup / 'index.after').write_bytes(after)
        meta = {'root': str(root.resolve()), 'index': str(index), 'before': sha(before), 'after': sha(after), 'count': len(selected)}
        (backup / 'index.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
        install_index(index, before, after)
        print('已取消 {} 个备份文件的Git跟踪；本地文件全部保留。'.format(len(selected)))
    finally:
        Path(temp).unlink(missing_ok=True)
        Path(temp + '.lock').unlink(missing_ok=True)

def restoration(root, backup):
    meta = json.loads((backup / 'index.json').read_text(encoding='utf-8'))
    found = inspect(root)
    if found is None:
        raise RuntimeError('恢复索引需要原Git工作区。')
    index, _ = found
    if str(root.resolve()) != meta['root'] or str(index) != meta['index']:
        raise RuntimeError('索引备份与当前仓库不匹配。')
    before = (backup / 'index.before').read_bytes()
    after = (backup / 'index.after').read_bytes()
    if sha(before) != meta['before'] or sha(after) != meta['after']:
        raise RuntimeError('索引备份损坏。')
    current = index.read_bytes()
    if current not in (before, after):
        # Git status can refresh stat-cache bytes without changing staged content.
        env = os.environ.copy(); env['GIT_INDEX_FILE'] = str((backup / 'index.after').resolve())
        expected_entries = git(root, 'ls-files', '--stage', '-z', env=env)
        if git(root, 'ls-files', '--stage', '-z') != expected_entries:
            raise RuntimeError('Git暂存区在整理后有变化，停止恢复以保护后续暂存内容。')
    return index, before, after, current

def restore(root, backup, check=False):
    index, before, after, current = restoration(root, backup)
    if not check and current != before:
        install_index(index, current, before)
    print('索引恢复预检通过。' if check else 'Git备份跟踪状态已恢复。')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument('--backup', required=True)
    parser.add_argument('--restore', action='store_true')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        root, backup = Path(args.root).resolve(), Path(args.backup).resolve()
        if args.restore:
            restore(root, backup, args.check)
        elif args.check:
            found = inspect(root)
            print('待取消跟踪的备份文件：' + str(len(found[1]) if found else 0))
        else:
            apply(root, backup)
    except Exception as error:
        parser.exit(1, '停止：' + str(error) + '\n')
