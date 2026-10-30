"""Explicit source placement for the CAST character-sheet pipeline."""
from . import outpaint_helpers as oh
class CastRegisteredCanvas:
 @classmethod
 def INPUT_TYPES(cls):
  return {'required':{'source':('IMAGE',),'target_width':('INT',{'default':1024,'min':16,'max':4096,'step':16}),'target_height':('INT',{'default':1536,'min':16,'max':4096,'step':16}),'source_width':('INT',{'default':320,'min':16,'max':2048,'step':16}),'top':('INT',{'default':48,'min':0,'max':2048}),'seam_px':('INT',{'default':16,'min':0,'max':256})}}
 RETURN_TYPES=('IMAGE','IMAGE','STRING','INT','INT')
 FUNCTION='prepare'
 CATEGORY='CAST/character sheet'
 def prepare(self,source,target_width,target_height,source_width,top,seam_px):
  # Match SaveImage PNG quantization before resizing the reference.
  im=oh.tensor_to_pil((source.clamp(0,1)*255).floor()/255);h=round(source_width*im.height/im.width);x=(target_width-source_width)//2
  p=oh.prepare_source(im,(target_width,target_height),(x,top,x+source_width,top+h),source_max_edge=384,seam_px=seam_px)
  return oh.pil_to_tensor(p.condition),oh.pil_to_tensor(p.placed_source),oh.placement_to_json(p),target_width,target_height
NODE_CLASS_MAPPINGS={'CastRegisteredCanvas':CastRegisteredCanvas}


class CastCharacterSheet:
    """Keep the full-resolution portrait beside the restored full-body reference."""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"portrait": ("IMAGE",), "full_body": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "assemble"
    CATEGORY = "CAST/character sheet"

    def assemble(self, portrait, full_body):
        import torch
        if portrait.shape[0] != full_body.shape[0] or portrait.shape[1] != full_body.shape[1] or portrait.shape[3] != full_body.shape[3]:
            raise ValueError("Portrait and body must have matching batch size, height and channels.")
        return (torch.cat((portrait, full_body), dim=2),)


class CastReferenceSize:
    """Choose the source width before placing the portrait on the body canvas."""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "height": (["Very short", "Short", "Average", "Tall"], {"default": "Average"}),
            "proportions": (["Natural", "Long-limbed", "Exaggerated", "Compact", "Oversized head"], {"default": "Natural"}),
        }}

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("source_width",)
    FUNCTION = "select"
    CATEGORY = "CAST/character sheet"

    def select(self, height, proportions):
        import json
        from pathlib import Path
        policy = json.loads((Path(__file__).parent / "reference-placement.json").read_text())
        return (policy[height]["oversized" if proportions == "Oversized head" else "default"],)
