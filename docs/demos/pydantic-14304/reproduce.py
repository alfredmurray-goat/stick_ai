from typing import Sequence
import pydantic
from pydantic import BaseModel

class Item(BaseModel):
    a: int = 1

class Model(BaseModel):
    items: Sequence[Item] = [Item(), Item(), Item()]

print('Pydantic:', pydantic.__version__, flush=True)
assert Model().model_dump(exclude={'items': {-1}}) == {'items': [{'a': 1}, {'a': 1}]}
