package tartan

// Review owners: tartan.review's repo policy.
extensions: "tartan.review": settings: owners: rules: [
	{paths: ["services/api/**"], sensitivity: 2, owners: ["@platform"]},
]
