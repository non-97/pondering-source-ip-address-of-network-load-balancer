import {
  RemovalPolicy,
  Stack,
  StackProps,
  aws_logs as logs,
  aws_iam as iam,
  aws_ec2 as ec2,
  aws_s3 as s3,
  aws_elasticloadbalancingv2 as elbv2,
  aws_elasticloadbalancingv2_targets as elbv2Targets,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as fs from "fs";

export class NlbStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // CloudWatch Logs Log Group for VPC Flow Logs
    const flowLogsLogGroup = new logs.LogGroup(this, "Flow Logs Log Group", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // SSM IAM Role
    const ssmIamRole = new iam.Role(this, "SSM IAM Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // VPC Flow Logs IAM role
    const flowLogsIamRole = new iam.Role(this, "Flow Logs IAM Role", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
    });

    // Create VPC Flow Logs IAM Policy
    const flowLogsIamPolicy = new iam.Policy(this, "Flow Logs IAM Policy", {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["iam:PassRole"],
          resources: [flowLogsIamRole.roleArn],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:DescribeLogStreams",
          ],
          resources: [flowLogsLogGroup.logGroupArn],
        }),
      ],
    });

    // Attach VPC Flow Logs IAM Policy
    flowLogsIamRole.attachInlinePolicy(flowLogsIamPolicy);

    // VPC
    const providerVPC = new ec2.Vpc(this, "Provider VPC", {
      cidr: "10.10.0.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 28,
        },
      ],
    });
    new ec2.CfnFlowLog(this, "Provider VPC Flow Log ", {
      resourceId: providerVPC.vpcId,
      resourceType: "VPC",
      trafficType: "ALL",
      deliverLogsPermissionArn: flowLogsIamRole.roleArn,
      logDestination: flowLogsLogGroup.logGroupArn,
      logDestinationType: "cloud-watch-logs",
      logFormat:
        "${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status} ${vpc-id} ${subnet-id} ${instance-id} ${tcp-flags} ${type} ${pkt-srcaddr} ${pkt-dstaddr} ${region} ${az-id} ${sublocation-type} ${sublocation-id} ${pkt-src-aws-service} ${pkt-dst-aws-service} ${flow-direction} ${traffic-path}",
      maxAggregationInterval: 60,
    });

    const consumerVPC = new ec2.Vpc(this, "Consumer VPC", {
      cidr: "10.11.0.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 28,
        },
      ],
    });
    new ec2.CfnFlowLog(this, "Consumer VPC Flow Log ", {
      resourceId: consumerVPC.vpcId,
      resourceType: "VPC",
      trafficType: "ALL",
      deliverLogsPermissionArn: flowLogsIamRole.roleArn,
      logDestination: flowLogsLogGroup.logGroupArn,
      logDestinationType: "cloud-watch-logs",
      logFormat:
        "${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status} ${vpc-id} ${subnet-id} ${instance-id} ${tcp-flags} ${type} ${pkt-srcaddr} ${pkt-dstaddr} ${region} ${az-id} ${sublocation-type} ${sublocation-id} ${pkt-src-aws-service} ${pkt-dst-aws-service} ${flow-direction} ${traffic-path}",
      maxAggregationInterval: 60,
    });

    // VPC Peering
    const vpcPeeringConnection = new ec2.CfnVPCPeeringConnection(
      this,
      "VPC Peering connection",
      {
        peerVpcId: providerVPC.vpcId,
        vpcId: consumerVPC.vpcId,
      }
    );

    // Route to VPC Peering connection
    providerVPC.isolatedSubnets.map((iSubnet: ec2.ISubnet, index: number) => {
      new ec2.CfnRoute(
        this,
        `Route to VPC Peering connection of isolated subnet in Provider VPC ${index}`,
        {
          routeTableId: iSubnet.routeTable.routeTableId,
          destinationCidrBlock: consumerVPC.vpcCidrBlock,
          vpcPeeringConnectionId: vpcPeeringConnection.ref,
        }
      );
    });
    providerVPC.publicSubnets.map((iSubnet: ec2.ISubnet, index: number) => {
      new ec2.CfnRoute(
        this,
        `Route to VPC Peering connection of public subnet in Provider VPC ${index}`,
        {
          routeTableId: iSubnet.routeTable.routeTableId,
          destinationCidrBlock: consumerVPC.vpcCidrBlock,
          vpcPeeringConnectionId: vpcPeeringConnection.ref,
        }
      );
    });
    consumerVPC.publicSubnets.map((iSubnet: ec2.ISubnet, index: number) => {
      new ec2.CfnRoute(
        this,
        `Route to VPC Peering connection of public subnet in Consumer VPC ${index}`,
        {
          routeTableId: iSubnet.routeTable.routeTableId,
          destinationCidrBlock: providerVPC.vpcCidrBlock,
          vpcPeeringConnectionId: vpcPeeringConnection.ref,
        }
      );
    });
    consumerVPC.isolatedSubnets.map((iSubnet: ec2.ISubnet, index: number) => {
      new ec2.CfnRoute(
        this,
        `Route to VPC Peering connection of isolated subnet in Consumer VPC ${index}`,
        {
          routeTableId: iSubnet.routeTable.routeTableId,
          destinationCidrBlock: providerVPC.vpcCidrBlock,
          vpcPeeringConnectionId: vpcPeeringConnection.ref,
        }
      );
    });

    // Provider EC2 Instance User Data
    const userDataProviderEC2InstanceParameter = fs.readFileSync(
      path.join(__dirname, "../src/ec2/user_data_provider_ec2_instance.sh"),
      "utf8"
    );
    const userDataProviderEC2Instance = ec2.UserData.forLinux({
      shebang: "#!/bin/bash",
    });
    userDataProviderEC2Instance.addCommands(
      userDataProviderEC2InstanceParameter
    );

    // Security Group
    const providerEC2InstanceSG = new ec2.SecurityGroup(
      this,
      "Provider EC2 Instance SG",
      {
        vpc: providerVPC,
        description: "",
        allowAllOutbound: true,
      }
    );
    providerEC2InstanceSG.addIngressRule(
      ec2.Peer.ipv4(providerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );
    providerEC2InstanceSG.addIngressRule(
      ec2.Peer.ipv4(consumerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );

    const albSG = new ec2.SecurityGroup(this, "ALB SG", {
      vpc: providerVPC,
      description: "",
      allowAllOutbound: true,
    });
    albSG.addIngressRule(
      ec2.Peer.ipv4(providerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );
    albSG.addIngressRule(
      ec2.Peer.ipv4(consumerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );

    const vpcEndpointSGOnConsumerVPC = new ec2.SecurityGroup(
      this,
      "VPC Endpoint SG on Consumer VPC",
      {
        vpc: consumerVPC,
        description: "",
        allowAllOutbound: true,
      }
    );
    vpcEndpointSGOnConsumerVPC.addIngressRule(
      ec2.Peer.ipv4(providerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );
    vpcEndpointSGOnConsumerVPC.addIngressRule(
      ec2.Peer.ipv4(consumerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );

    const vpcEndpointSGOnProviderVPC = new ec2.SecurityGroup(
      this,
      "VPC Endpoint SG on Provider VPC",
      {
        vpc: providerVPC,
        description: "",
        allowAllOutbound: true,
      }
    );
    vpcEndpointSGOnProviderVPC.addIngressRule(
      ec2.Peer.ipv4(providerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );
    vpcEndpointSGOnProviderVPC.addIngressRule(
      ec2.Peer.ipv4(consumerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );

    // EC2 Instance
    const providerEC2Instance = new ec2.Instance(
      this,
      "Provider EC2 Instance",
      {
        instanceType: new ec2.InstanceType("t3.micro"),
        machineImage: ec2.MachineImage.latestAmazonLinux({
          generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
        }),
        vpc: providerVPC,
        blockDevices: [
          {
            deviceName: "/dev/xvda",
            volume: ec2.BlockDeviceVolume.ebs(8, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
            }),
          },
        ],
        propagateTagsToVolumeOnCreation: true,
        vpcSubnets: providerVPC.selectSubnets({
          subnetType: ec2.SubnetType.PUBLIC,
        }),
        securityGroup: providerEC2InstanceSG,
        role: ssmIamRole,
        userData: userDataProviderEC2Instance,
      }
    );

    new ec2.Instance(this, "Consumer EC2 Instance on Provider VPC", {
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc: providerVPC,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: providerVPC.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      role: ssmIamRole,
    });

    new ec2.Instance(this, "Consumer EC2 Instance on Consumer VPC", {
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc: consumerVPC,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: consumerVPC.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      role: ssmIamRole,
    });

    const albAccessLogBucket = new s3.Bucket(
      this,
      "Bucket for ALB access log",
      {
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        autoDeleteObjects: true,
        removalPolicy: RemovalPolicy.DESTROY,
      }
    );

    // ALB
    // const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
    //   vpc: providerVPC,
    //   vpcSubnets: {
    //     subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    //   },
    //   securityGroup: albSG,
    // });
    // alb.logAccessLogs(albAccessLogBucket);

    // const albListener = alb.addListener("ALB Listener", {
    //   port: 80,
    // });
    // albListener.addTargets("ALB Targets", {
    //   port: 80,
    //   targets: [new elbv2Targets.InstanceTarget(providerEC2Instance, 80)],
    // });

    // NLB
    const nlb = new elbv2.NetworkLoadBalancer(this, "NLB", {
      vpc: providerVPC,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });
    const nlbListener = nlb.addListener("NLB Listener", {
      port: 80,
    });
    nlbListener.addTargets("NLB Targets", {
      protocol: elbv2.Protocol.TCP,
      port: 80,
      preserveClientIp: false,
      // preserveClientIp: true,
      targets: [new elbv2Targets.InstanceTarget(providerEC2Instance, 80)],
      // targets: [
      //   new elbv2Targets.IpTarget(providerEC2Instance.instancePrivateIp, 80),
      // ],
      // targets: [new elbv2Targets.AlbTarget(alb, 80)],
    });

    // VPC Endpoint service
    const vpcEndpointService = new ec2.VpcEndpointService(
      this,
      "Endpoint Service",
      {
        vpcEndpointServiceLoadBalancers: [nlb],
        acceptanceRequired: false,
        allowedPrincipals: [
          new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
        ],
      }
    );

    // VPC Endpoint
    new ec2.InterfaceVpcEndpoint(this, "VPC Endpoint on Consumer VPC", {
      vpc: consumerVPC,
      service: new ec2.InterfaceVpcEndpointService(
        vpcEndpointService.vpcEndpointServiceName,
        80
      ),
      subnets: consumerVPC.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      securityGroups: [vpcEndpointSGOnConsumerVPC],
    });

    new ec2.InterfaceVpcEndpoint(this, "VPC Endpoint on Provider VPC", {
      vpc: providerVPC,
      service: new ec2.InterfaceVpcEndpointService(
        vpcEndpointService.vpcEndpointServiceName,
        80
      ),
      subnets: providerVPC.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      securityGroups: [vpcEndpointSGOnProviderVPC],
    });

    // Network ACL
    const providerVPCIsolatedSubnetNetworkACL = new ec2.NetworkAcl(
      this,
      "Provider VPC Isolated subnet Network ACL",
      {
        vpc: providerVPC,
        subnetSelection: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      }
    );
    providerVPCIsolatedSubnetNetworkACL.addEntry(
      "Allow ingress traffic from target instance",
      {
        cidr: ec2.AclCidr.ipv4(`${providerEC2Instance.instancePrivateIp}/32`),
        ruleNumber: 100,
        traffic: ec2.AclTraffic.allTraffic(),
        direction: ec2.TrafficDirection.INGRESS,
        ruleAction: ec2.Action.ALLOW,
      }
    );
    providerVPCIsolatedSubnetNetworkACL.addEntry("Allow all egress traffic", {
      cidr: ec2.AclCidr.anyIpv4(),
      ruleNumber: 100,
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.EGRESS,
      ruleAction: ec2.Action.ALLOW,
    });
  }
}
