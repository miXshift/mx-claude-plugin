- **Listing edits through `amazon call listings.patch_listings_item` now reach
  the preview.** Before, the change set you passed with `--body` or `--body-file`
  never arrived, so every try, even on one SKU, was refused with "requires a
  changeSet". Pass the change set with `--change-set-file` (a body holding it
  still works) to get a preview. Where your account can write listings, commit
  that preview with `--commit --change-set-id <id> --approved-change-set-hash
  <hash>`, both taken from the preview. Search terms (`generic_keyword`) and titles (`item_name`) are among
  the attributes you can change this way.
