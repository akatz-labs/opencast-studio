"""One isolated ComfyGit operation, with retained graphs and no external AI API."""
import json
import os
import re
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error


def save(file, data):
    file = Path(file)
    pending = file.with_suffix(file.suffix + '.pending')
    pending.write_text(json.dumps(data, indent=2))
    pending.replace(file)


def dependencies(graph, roots):
    selected = {}
    def visit(key):
        if key in selected:
            return
        selected[key] = graph[key]
        for value in graph[key]['inputs'].values():
            if isinstance(value, list):
                visit(value[0])
    for root in roots:
        visit(root)
    return selected


def main(request):
    root = Path(request['directory'])
    inputs, outputs = Path(request['inputs']), Path(request['outputs'])
    media = root / 'motion-media'
    media.mkdir(exist_ok=True)
    raw = root / 'motion-raw'
    raw.mkdir(exist_ok=True)
    character = request['kind'] == 'character'
    task = 'character' if character else 'motion'
    params = request.get('parameters', {})
    process = None
    receipt = {'status': 'failed', 'runtimeStopped': True}
    cancel = root / (task+'-cancel')
    started = time.monotonic()
    def check_cancel():
        if cancel.exists():
            raise InterruptedError('Cancelled by user.')
    def status(phase, stage, **extra):
        save(root / (task+'-status.json'), {'phase': phase, 'stage': stage, **extra})
    def ffmpeg(args):
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *args], check=True, timeout=300)
    try:
        check_cancel()
        if character:
            status('preparing', 'Preparing character sheet')
            manifest = json.loads((inputs/'manifest.json').read_text())
            graph = json.loads(Path(request['graph']).read_text())
        else:
            status('preparing', 'Normalizing source to 24 fps')
            # Decode at most the contract's 15-second input cap. Preserve source audio.
            ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', str(inputs/'source-upload'), '-t', '15',
                    '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'fps=24,setsar=1', '-c:v', 'libx264',
                    '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(media/'source.mp4')])
            for role in ['character', *(['background'] if request['background'] else [])]:
                ffmpeg(['-i', str(inputs/(role+'-upload')), '-frames:v', '1', str(media/(role+'.png'))])
            graph = json.loads(Path(request['graph']).read_text())
            graph['10']['inputs']['file'] = 'source.mp4'
            graph['12']['inputs']['image'] = 'character.png'
            graph['13']['inputs']['image'] = 'background.png' if request['background'] else 'character.png'
            graph['25']['inputs']['value'] = params['prompt'].strip() or 'Replace the main person in the video.'
            for key, value in [('501', params['anchorSeed']), ('502', params['seed']),
                               ('503', request['kind']=='motion-transfer'), ('504', request['background']),
                               ('505', params['quality']=='720p')]:
                graph[key]['inputs']['value'] = value
        save(outputs/'workflow.json', graph)
        check_cancel()
        with socket.socket() as port_socket:
            port_socket.bind(('127.0.0.1', 0))
            port = port_socket.getsockname()[1]
        origin = 'http://127.0.0.1:'+str(port)
        env = Path(request['environmentRoot'])
        command = [request['cg'], '-e', env.name, 'run', '--no-sync', '--', '--listen', '127.0.0.1',
                   '--port', str(port), '--disable-auto-launch', '--reserve-vram', '0',
                   '--enable-dynamic-vram', '--enable-triton-backend', '--disable-comfy-compiler',
                   *([] if character else ['--disable-all-custom-nodes']),
                   '--input-directory', str(media), '--output-directory', str(raw)]
        save(root/'launch.json', {'command': command, 'workspace': request['workspace'], 'port': port})
        log = (root/'comfy.log').open('w')
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   env={**os.environ, 'COMFYGIT_HOME': request['workspace']}, start_new_session=True)
        receipt['runtimeStopped'] = False
        def api(route, data=None):
            req = urllib.request.Request(origin+route, data=None if data is None else json.dumps(data).encode(),
                                         headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as response:
                body = response.read()
                return json.loads(body) if body else None
        deadline = time.monotonic()+180
        while True:
            check_cancel()
            if process.poll() is not None:
                raise RuntimeError('ComfyUI could not start. See the retained comfy.log.')
            try:
                system = api('/system_stats')
                break
            except (urllib.error.URLError, TimeoutError):
                if time.monotonic()>deadline:
                    raise TimeoutError('ComfyUI startup timed out.')
                time.sleep(1)
        save(outputs/'runtime.json', system)
        def render(stage, prompt):
            check_cancel()
            save(outputs/(stage+'-api.json'), prompt)
            # One submission only. Any lost response is retained as uncertainty.
            save(root/(stage+'-attempt.json'), {'submitted': False, 'started': time.time()})
            submitted = api('/prompt', {'prompt': prompt, 'client_id': request['jobId']})
            save(outputs/(stage+'-submission.json'), submitted)
            prompt_id = submitted['prompt_id']
            while True:
                check_cancel()
                if process.poll() is not None:
                    raise RuntimeError('ComfyUI exited during '+stage+'. See comfy.log.')
                history = api('/history/'+prompt_id)
                if prompt_id in history:
                    history = history[prompt_id]
                    save(outputs/(stage+'-history.json'), history)
                    if history['status']['status_str']!='success':
                        errors = [item[1].get('exception_message', str(item[1])) for item in history['status']['messages'] if item[0]=='execution_error']
                        raise RuntimeError(stage+' failed: '+'; '.join(errors))
                    return history
                status('rendering', stage, promptId=prompt_id)
                time.sleep(1)
        if character:
            history = render('character', graph)
            status('finalizing', 'Saving close-up and full-body sheet')
            for spec in manifest['contract']['contracts']['character']['outputs']:
                image = history['outputs'][spec['node_id']][spec['selector']][0]
                source = (raw/image.get('subfolder', '')/image['filename']).resolve()
                if not source.is_relative_to(raw.resolve()):
                    raise RuntimeError('Unexpected character output path.')
                shutil.copyfile(source, outputs/(spec['name']+'.png'))
            details = {**manifest['details'], 'executionSeconds': time.monotonic()-started}
            manifest['details'] = details
            save(outputs/'manifest.json', manifest)
        else:
            # Execute the packaged anchor subgraph, then release its models before H3.
            anchor = render('anchor', dependencies(graph, ['248', '7152']))
            image = anchor['outputs']['248']['images'][0]
            anchor_file = (raw/image.get('subfolder', '')/image['filename']).resolve()
            if not anchor_file.is_relative_to(raw.resolve()):
                raise RuntimeError('Unexpected anchor output path.')
            shutil.copyfile(anchor_file, outputs/'anchor.png')
            shutil.copyfile(anchor_file, media/'anchor.png')
            expanded = anchor['outputs'].get('7152', {})
            save(outputs/'expanded-prompt.json', expanded)
            api('/free', {'unload_models': True, 'free_memory': True})
            # Replace only the anchor edge; all Pika prompts, references and audio stay intact.
            graph['99991'] = {'class_type': 'LoadImage', 'inputs': {'image': 'anchor.png'}}
            for node in graph.values():
                for key, value in node['inputs'].items():
                    if value == ['7108', 0]:
                        node['inputs'][key] = ['99991', 0]
            video = render('video', dependencies(graph, ['23']))
            status('finalizing', 'Retaining video and provenance')
            files = video['outputs']['23']
            reference = next(f for group in files.values() if isinstance(group, list) for f in group
                             if isinstance(f, dict) and str(f.get('filename', '')).endswith(('.mp4', '.webm', '.mkv')))
            source = (raw/reference.get('subfolder', '')/reference['filename']).resolve()
            if not source.is_relative_to(raw.resolve()):
                raise RuntimeError('Unexpected video output path.')
            shutil.copyfile(source, outputs/('native'+source.suffix))
            ffmpeg(['-i', str(source), '-map', '0:v:0', *(['-map', '0:a?'] if params['keepAudio'] else ['-an']),
                    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', str(outputs/'video.mp4')])
            ffmpeg(['-i', str(outputs/'video.mp4'), '-frames:v', '1', str(outputs/'poster.png')])
            probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(outputs/'video.mp4')]))
            stream = next(s for s in probe['streams'] if s['codec_type']=='video')
            details = {**params, 'kind': request['kind'], 'width': stream['width'], 'height': stream['height'],
                       'duration': float(probe['format']['duration']), 'executionSeconds': time.monotonic()-started,
                       'audio': 'generated' if params['keepAudio'] else 'muted', 'fps': 24,
                       'workflowVersion': 'opencast-motion-flux3-v1', 'anchorRecipe': 'FLUX3 distilled INT8, official PUP, Euler/simple, 16 steps, CFG 1, 1 MP'}
            save(outputs/'manifest.json', {'schemaVersion': 1, 'jobId': request['jobId'], **details})
        receipt.update(status='complete', details=details, files=[p.name for p in outputs.iterdir() if p.is_file()])
    except InterruptedError as error:
        receipt.update(status='cancelled', error=str(error))
    except Exception as error:
        message = str(error)
        runtime_log = root/'comfy.log'
        if runtime_log.exists():
            # CUDA failures can stall the HTTP server before it returns history.
            # Preserve the actual failure instead of presenting only a timeout.
            with runtime_log.open('rb') as stream:
                stream.seek(max(0, runtime_log.stat().st_size-65536))
                tail = stream.read().decode(errors='replace')
            match = re.search(r'!!! Exception during processing !!! ([^\r\n]+)', tail)
            if match:
                message = re.sub(r'\x1b\[[0-9;]*m', '', match.group(1)).strip()
        receipt.update(status='failed', error=message)
    finally:
        if process and process.poll() is None:
            # Kill only this operation's process group; never an existing ComfyUI.
            import signal
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=15)
        receipt['runtimeStopped'] = process is None or process.poll() is not None
        save(root/(task+'-receipt.json'), receipt)
    return 0 if receipt['status']=='complete' else 1


if __name__ == '__main__':
    sys.exit(main(json.loads(Path(sys.argv[1]).read_text())))
