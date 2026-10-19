"""Test-session defaults.

The literature tests mock Semantic Scholar and OpenAlex without keys; the key
gates (drivers/literature/search_lib/key_gates.py) are off for them, and
tests/literature_key_gates_test.py turns them on to test the gates themselves.
"""

import os

os.environ.setdefault("RESEARCHLAB_KEY_GATES", "off")
