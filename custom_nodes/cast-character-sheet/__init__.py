from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

from .cast_canvas import CastRegisteredCanvas
NODE_CLASS_MAPPINGS['CastRegisteredCanvas']=CastRegisteredCanvas

from .cast_canvas import CastCharacterSheet
NODE_CLASS_MAPPINGS['CastCharacterSheet'] = CastCharacterSheet
from .cast_canvas import CastReferenceSize
NODE_CLASS_MAPPINGS['CastReferenceSize'] = CastReferenceSize
