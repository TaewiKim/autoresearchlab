"""Source of the validation blueprints this driver generates.

Each module holds one blueprint's code as the string its builder returns.
They live apart from the search and handoff logic because they are data:
4,939 lines of generated-program text that used to sit inside the driver
functions and made five of its files exceed a thousand lines.
"""

from .reference_baseline import (  # noqa: F401
    _reference_baseline_audit_blueprint_code,
)
from .same_dataset_baseline import (  # noqa: F401
    _same_dataset_baseline_reproduction_blueprint_code,
)
from .confounder_sensitivity import (  # noqa: F401
    _confounder_sensitivity_blueprint_code,
)
from .term_table_topic import (  # noqa: F401
    _term_table_topic_blueprint_code,
)
from .wide_table_stability import (  # noqa: F401
    _wide_table_stability_blueprint_code,
)
from .signature_score_contest import (  # noqa: F401
    _signature_score_contest_blueprint_code,
)
from .render_quality import (  # noqa: F401
    _render_quality_blueprint_code,
)
from .open_source_adapter import (  # noqa: F401
    _open_source_workflow_adapter_code,
)
from .external_repo_wrapper import (  # noqa: F401
    _external_repo_agent_wrapper_code,
)
from .geo_binary_outcome import (  # noqa: F401
    _geo_binary_outcome_blueprint_code,
)
from .published_8_gene_audit import (  # noqa: F401
    _published_8_gene_audit_blueprint_code,
)
from .geomx_spatial import (  # noqa: F401
    _geomx_spatial_blueprint_code,
)
from .generic_validation import (  # noqa: F401
    _generic_validation_blueprint_code,
)
from .analysis_master_table import (  # noqa: F401
    _analysis_master_table_blueprint_code,
)
