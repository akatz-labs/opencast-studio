"""Pinned Hugging Face cache paths and cross-process use/removal coordination.

Hugging Face owns the cache index and blobs. Every Akatz consumer holds this
lease while loading or using a model; downloads and reviewed deletion use an
exclusive model lease. Cache maintenance also fences other consumers/downloads.
"""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re


class CacheBusy(RuntimeError):
    pass


def snapshot_path(cache, repo, revision):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", repo):
        raise ValueError("Invalid Hugging Face model ID")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("A pinned model revision is required")
    return Path(cache) / ("models--" + repo.replace("/", "--")) / "snapshots" / revision


@contextmanager
def cache_use(cache, repo, *, exclusive=False, maintenance=False):
    import fcntl  # Linux execution is qualified; platform paths alone do not qualify Windows.
    cache = Path(cache).resolve()
    locks = cache / ".akatz-locks"
    locks.mkdir(parents=True, exist_ok=True)
    model = hashlib.sha256(repo.encode()).hexdigest()
    handles = []
    try:
        for name, write in [("cache", maintenance), (model, exclusive or maintenance)]:
            fd = os.open(locks / (name + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            handles.append(fd)
            try:
                fcntl.flock(fd, (fcntl.LOCK_EX if write else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise CacheBusy("The shared model cache is busy in another app. Wait for model use or downloads to finish.") from error
        yield
    finally:
        for fd in reversed(handles):
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
