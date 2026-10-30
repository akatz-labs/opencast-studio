"""Explicit GPU regression: INT8 output indexing beyond signed 32-bit range.

Run inside the pinned Pika environment through the worker GPU admission system.
Requires roughly 5 GiB of VRAM; not part of the CPU-only npm test suite.
"""
import json, torch
from comfy_kitchen.backends.triton.quantization import int8_linear
m,n,k=76001,28672,64
x=torch.ones((m,k),device='cuda',dtype=torch.bfloat16)
w=torch.ones((n,k),device='cuda',dtype=torch.int8)
s=torch.ones(n,device='cuda',dtype=torch.float32)
y=int8_linear(x,w,s)
torch.cuda.synchronize()
rows=y[[0,32767,74900,76000]]
assert torch.all(rows==64), (rows.min().item(),rows.max().item())
print(json.dumps({'shape':[m,n,k],'output_elements':m*n,'exceeds_int32':m*n>2**31-1,'sampled_rows_correct':True,'peak_allocated':torch.cuda.max_memory_allocated()}))
