"""Non-production latest-frame host and consumer experiments.

The formal Scene Engine package root intentionally excludes these APIs.  They
remain available only for diagnostics and non-production experimental profiles.
"""

from ..consumer import (
    CompleteFrameConsumer,
    ConsumeResult,
    InstalledDisplayEntity,
    StaleFramePolicy,
)
from ..display_frame import (
    DisplayFrameLimits,
    DisplayFrameView,
    DisplayFrameWriter,
    DynamicEntityRecordV1,
    SealedDisplayFrame,
    parse_display_frame,
)
from ..host import SceneEngine
from ..latest_mailbox import DisplayFrameLease, LatestFrameMailbox

__all__ = [
    "CompleteFrameConsumer",
    "ConsumeResult",
    "DisplayFrameLease",
    "DisplayFrameLimits",
    "DisplayFrameView",
    "DisplayFrameWriter",
    "DynamicEntityRecordV1",
    "InstalledDisplayEntity",
    "LatestFrameMailbox",
    "SceneEngine",
    "SealedDisplayFrame",
    "StaleFramePolicy",
    "parse_display_frame",
]
