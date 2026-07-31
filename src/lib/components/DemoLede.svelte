<!--
	DemoLede - a demo page's intro paragraph.

	Full prose from the two-column container rung up; below it the same
	prose collapses behind a "How it works" summary so the demo's first
	control stays above the fold on phones. One content snippet, rendered
	into whichever presentation the rung calls for.
-->
<script>
	let { children } = $props()
</script>

<p class="text-sm opacity-70 mt-1 hidden @2xl:block">{@render children()}</p>
<details class="@2xl:hidden mt-1">
	<summary class="text-sm opacity-70 cursor-pointer select-none list-inside">How it works</summary>
	<p class="text-sm opacity-70 mt-1">{@render children()}</p>
</details>
