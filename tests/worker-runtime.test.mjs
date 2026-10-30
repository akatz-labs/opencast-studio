import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('both workers explicitly enable dynamic VRAM and report CUDA failures instead of startup symptoms',()=>{
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util, json, tempfile
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('worker', 'resources/motion/worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
for kind in ['character', 'character-swap']:
    with tempfile.TemporaryDirectory() as directory:
        root=Path(directory);inputs=root/'inputs';outputs=root/'outputs'
        inputs.mkdir();outputs.mkdir()
        (inputs/'manifest.json').write_text('{}')
        graph={key:{'inputs':{}} for key in ['10','12','13','25','501','502','503','504','505']}
        (root/'graph.json').write_text(json.dumps(graph))
        commands=[]
        class StoppedProcess:
            def __init__(self, command, **kwargs):
                commands.append(command)
                (root/'comfy.log').write_text('[ERROR] !!! Exception during processing !!! CUDA error: an illegal memory access was encountered\n')
            def poll(self):return 1
        request={'kind':kind,'directory':directory,'inputs':str(inputs),'outputs':str(outputs),'graph':str(root/'graph.json'),
                 'environmentRoot':'/isolated/environment','cg':'cg','workspace':'/isolated','background':False,
                 'parameters':{'prompt':'Replace the person.','anchorSeed':1,'seed':2,'quality':'480p'}}
        with patch.object(worker.subprocess,'Popen',StoppedProcess),patch.object(worker.subprocess,'run'):
            assert worker.main(request)==1
        assert '--enable-dynamic-vram' in commands[0]
        assert not set(['--highvram','--disable-dynamic-vram','--disable-smart-memory'])&set(commands[0])
        assert commands[0][commands[0].index('--reserve-vram')+1]=='0'
        task='character' if kind=='character' else 'motion'
        receipt=json.loads((root/(task+'-receipt.json')).read_text())
        assert receipt['runtimeStopped'] is True
        assert receipt['error']=='CUDA error: an illegal memory access was encountered',receipt
print('Both launch contracts and actionable failure receipts passed')
`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
