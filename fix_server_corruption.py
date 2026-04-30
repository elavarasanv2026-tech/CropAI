#!/usr/bin/env python3
"""Targeted fix: remove the extra }); sequence after the chat route."""

with open('server.js', 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

# The problem pattern (with \n line endings now):
# "isFallback: true\n\n        });\n\n    }\n\n});\n\n    }\n});\n"
# ^-- correct end --------^  ^-- extra bad bit --^

# Replace with correct single ending:
bad = "isFallback: true\n\n        });\n\n    }\n\n});\n\n    }\n});\n"
good = "isFallback: true\n        });\n    }\n});\n"

if bad in content:
    content = content.replace(bad, good, 1)
    print("Fixed with primary pattern!")
else:
    # More permissive: find by index
    # Find "isFallback: true"
    idx = content.find("isFallback: true")
    # Find the NEXT "// Helper function" which is where the good code starts
    helper_idx = content.find("// Helper function for local fallback responses", idx)
    
    # Extract the problematic section
    bad_section = content[idx:helper_idx]
    print(f"Bad section ({len(bad_section)} chars):")
    print(repr(bad_section))
    
    # Replace the bad section with just the correct closing
    correct_closing = "isFallback: true\n        });\n    }\n});\n\n\n\n\n"
    content = content[:idx] + correct_closing + content[helper_idx:]
    print(f"Replaced bad section with correct closing")

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(content)

import subprocess
result = subprocess.run(['node', '--check', 'server.js'], capture_output=True, text=True)
print("Syntax check STDERR:", result.stderr[:500] if result.stderr else "None")
print("Return code:", result.returncode)
if result.returncode == 0:
    print("SUCCESS! server.js is now valid JavaScript!")
