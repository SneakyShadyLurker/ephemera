CREATE TABLE `custom_palettes` (
	`slot` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base` text NOT NULL,
	`light` text NOT NULL,
	`dark` text NOT NULL,
	`origin` text NOT NULL,
	`hand_set` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "custom_palettes_slot" CHECK("custom_palettes"."slot" BETWEEN 1 AND 3)
);
