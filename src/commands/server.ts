import { ApplyOptions } from "@sapphire/decorators";
import { Command } from "@sapphire/framework";
import { EmbedBuilder } from "discord.js";
import { DateTime } from "luxon";
import humanizeDuration from "humanize-duration";
import axios from "axios";

@ApplyOptions<Command.Options>({
  name: "server",
  description: "Kuvab informatsiooni serveri kohta",
})
export class UserCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder.setName(this.name).setDescription(this.description),
    );
  }

  public async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    const guild = interaction.guild;
    if (!guild) return;
    const guildID = guild.id;
    const channel = interaction.guild.channels.cache.find(
      (c) => c.id === process.env.INVITE_CHANNEL_ID,
    );
    const getMemberCount = guild.memberCount;
    const getGuildLogo = guild.iconURL();
    const serverCreationDate = DateTime.fromJSDate(guild.createdAt)
      .setZone("Europe/Tallinn")
      .setLocale("et")
      .toFormat("d.MMMM yyyy HH:mm");
    console.log(channel);
    const timePassedSinceCreation = humanizeDuration(
      guild.createdTimestamp - Date.now(),
      {
        language: "et",
        round: true,
        conjunction: " ja ",
        largest: 2,
        serialComma: false,
      },
    );
    if (!channel || !("createInvite" in channel)) {
      console.log(interaction.reply("no invite channel."));
      return;
    }

    const invite = await channel.createInvite({
      maxAge: 0,
      maxUses: 0,
    });

    const { data } = await axios.get(
      `https://discord.com/api/guilds/${guildID}/widget.json`,
    );

    const onlineMembers = data.presence_count;
    const serverName = data.name;
    const embed = new EmbedBuilder()
      .setColor("#71368A")
      .setTitle(serverName)
      .setURL("https://kunstikohvik.ee/")
      .setThumbnail(getGuildLogo)
      .addFields({
        name: `👥 **${getMemberCount} Kasutajat**`,
        value: `🟢 **${onlineMembers} Online**`,
      })
      .addFields({
        name: `Kutse link:`,
        value: `${invite.url}`,
      })
      .addFields({
        name: "🕙 ** Server Loodud** ",
        value: `${serverCreationDate} (${timePassedSinceCreation} tagasi)`,
        inline: true,
      });

    await interaction.reply({ embeds: [embed] });
  }
}
