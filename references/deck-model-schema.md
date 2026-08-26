# Deck Model Schema

Map an approved outline to this shared model before generating HTML or PPTX:

```json
{
  "meta": {
    "title": "Deck title",
    "styleId": "product-narrative",
    "secondaryStyleId": null,
    "secondaryOverrides": [],
    "aspectRatio": "16:9"
  },
  "slides": [
    {
      "id": "p01",
      "type": "cover",
      "title": "One clear message",
      "subtitle": "Supporting context",
      "body": [],
      "metric": null,
      "sections": [],
      "sourceRefs": []
    }
  ]
}
```

Use only these slide types, exactly:

```text
cover, section, statement, data, process, comparison, case-study,
timeline, matrix, image, quote, summary
```

Use one primary style. Primary-only selection is valid with `secondaryStyleId: null` and an empty or omitted `secondaryOverrides`. When a secondary style is selected, require one or both executable overrides: `chart-treatment`, `section-divider`. Reject every other override and reject unsupported slide types before either renderer starts.
